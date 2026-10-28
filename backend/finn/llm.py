"""LLM access: provider + model routing, a persistent response cache, and a usage ledger.

Providers (chosen by which key is set; FINN_LLM_PROVIDER overrides):
  gemini     GEMINI_API_KEY      free tier, the default (plain REST; no SDK)
  anthropic  ANTHROPIC_API_KEY   paid

Routing tiers:
  cheap   bulk extraction (one call per filing / transcript / annual report / question)
  strong  the one judgement call per company

Free-tier models get overloaded (503) at peak times, so each Gemini model has a fallback that is
tried automatically. Every response is cached in SQLite by a hash of (provider, model, prompt,
schema): re-running the pipeline costs nothing, and hitting a daily quota loses no finished work.
"""
import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
import time

import requests

from .db import now_ist

log = logging.getLogger(__name__)

ROUTES = {
    "gemini": {
        "cheap": os.environ.get("FINN_CHEAP_MODEL", "gemini-3.5-flash-lite"),
        "strong": os.environ.get("FINN_STRONG_MODEL", "gemini-3.6-flash"),
    },
    "anthropic": {
        "cheap": os.environ.get("FINN_CHEAP_MODEL", "claude-haiku-5-5"),
        "strong": os.environ.get("FINN_STRONG_MODEL", "claude-opus-5-5"),
    },
}
GEMINI_FALLBACKS = {
    "gemini-3.5-flash-lite": ["gemini-3.1-flash-lite"],
    "gemini-3.6-flash": ["gemini-3-flash-preview", "gemini-3.5-flash-lite"],
    "gemini-3.8-flash": ["gemini-3.6-flash", "gemini-3-flash-preview"],
}
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"
# $ per million tokens (input, output, cache read). Gemini free tier: zero.
PRICES = {
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20),
    "claude-opus-5-5": (4.00, 20.00, 0.20),
}
ANTHROPIC_FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"}
# Free tiers cap requests per minute; space calls out rather than collect 429s.
MIN_INTERVAL_S = float(os.environ.get("FINN_LLM_MIN_INTERVAL", "4"))


class LLMUnavailable(RuntimeError):
    pass


class LLMError(RuntimeError):
    pass


class QuotaExhausted(LLMError):
    """Daily free-tier quota used up. Cached work is kept; the next run picks up where this stopped."""


class Overloaded(LLMError):
    """Model busy or not responding; try the next fallback."""


def provider() -> str | None:
    forced = os.environ.get("FINN_LLM_PROVIDER")
    if forced:
        return forced
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        return "gemini"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    return None


def available() -> bool:
    return provider() is not None


def model_for(tier: str) -> str:
    p = provider()
    if not p:
        raise LLMUnavailable("Set GEMINI_API_KEY (free) to enable summaries and research analysis.")
    return ROUTES[p][tier]


# ---- shared plumbing ---------------------------------------------------------------------------

_last_call: dict[str, float] = {}
_pace_lock = threading.Lock()


def _pace(model: str) -> None:
    if MIN_INTERVAL_S <= 0:
        return
    with _pace_lock:
        wait = _last_call.get(model, 0) + MIN_INTERVAL_S - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_call[model] = time.monotonic()


def _key(*parts) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _cached(conn: sqlite3.Connection, key: str):
    row = conn.execute("SELECT response FROM llm_cache WHERE key=?", (key,)).fetchone()
    return json.loads(row["response"]) if row else None


def _store(conn, key, model, purpose, result, usage: dict) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO llm_cache (key, model, purpose, response, in_tokens, out_tokens, cost_usd, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (key, model, purpose, json.dumps(result), usage["in"], usage["out"], round(_cost(model, usage), 6),
         now_ist().isoformat(timespec="seconds")),
    )
    conn.commit()


def _cost(model: str, u: dict) -> float:
    p_in, p_out, p_cache = PRICES.get(model, (0, 0, 0))
    return (u["in"] * p_in + u.get("cache_write", 0) * p_in * 1.25 + u.get("cache_read", 0) * p_cache
            + u["out"] * p_out) / 1e6


def _inline_refs(schema: dict) -> dict:
    """Gemini accepts JSON Schema but not $defs/$ref (except self-reference); inline them."""
    defs = schema.get("$defs", {})

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node and node["$ref"].startswith("#/$defs/"):
                return walk(defs[node["$ref"].split("/")[-1]])
            return {k: walk(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node
    return walk(schema)


# ---- Gemini (REST) -----------------------------------------------------------------------------

def _gemini_once(model: str, body: dict, purpose: str) -> dict:
    """One model, with retries for per-minute limits. Raises Overloaded to move to a fallback."""
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    for attempt in range(4):
        _pace(model)
        try:
            r = requests.post(GEMINI_URL.format(model), headers={"x-goog-api-key": key}, json=body, timeout=(10, 150))
        except requests.Timeout:
            raise Overloaded(f"{model} timed out")
        except requests.ConnectionError as e:
            if attempt < 2:
                time.sleep(5)
                continue
            raise LLMError(f"{purpose}: network error {e}") from e
        if r.status_code == 200:
            return r.json()
        detail = r.text[:2000]
        if r.status_code == 429:
            if re.search(r"PerDay|per day", detail, re.I):
                raise QuotaExhausted(f"{model}: daily free-tier quota used up")
            delay = re.search(r'"retryDelay":\s*"(\d+)', detail)
            wait = int(delay.group(1)) + 1 if delay else 15 * (attempt + 1)
            if wait > 90:
                raise QuotaExhausted(f"{model}: rate limit resets in {wait}s")
            log.info("%s rate-limited; waiting %ss", model, wait)
            time.sleep(wait)
            continue
        if r.status_code in (500, 503, 504):
            if attempt < 1:
                time.sleep(4)
                continue
            raise Overloaded(f"{model} returned {r.status_code}")
        if r.status_code == 404:
            raise Overloaded(f"{model} not available to this key")
        raise LLMError(f"{purpose}: {model} returned {r.status_code}: {detail[:300]}")
    raise Overloaded(f"{model} still rate-limited")


def _gemini(model: str, body: dict, purpose: str) -> tuple[dict, str]:
    """Try the routed model, then its fallbacks. Returns (response, model that served it)."""
    chain = [model, *GEMINI_FALLBACKS.get(model, [])]
    last = None
    for m in chain:
        try:
            return _gemini_once(m, body, purpose), m
        except Overloaded as e:
            log.warning("%s: %s; trying next model", purpose, e)
            last = e
    raise LLMError(f"{purpose}: all models busy ({last})")


def _gemini_text(j: dict, purpose: str) -> str:
    cand = (j.get("candidates") or [{}])[0]
    reason = cand.get("finishReason")
    if reason == "MAX_TOKENS":
        raise LLMError(f"{purpose}: output truncated")
    text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []) if not p.get("thought"))
    if not text:
        raise LLMError(f"{purpose}: empty response ({reason or j.get('promptFeedback')})")
    return text


def _gemini_usage(j: dict) -> dict:
    u = j.get("usageMetadata", {})
    return {"in": u.get("promptTokenCount", 0), "out": u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0),
            "cache_read": u.get("cachedContentTokenCount", 0)}


def _gemini_json(model, system, documents, prompt, schema, effort, max_tokens, purpose):
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        # Documents first, question last: Gemini's implicit prefix cache then reuses the documents.
        "contents": [{"role": "user", "parts": [{"text": t} for t in [*(documents or []), prompt]]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": _inline_refs(schema),
            "maxOutputTokens": max_tokens,
            "thinkingConfig": {"thinkingLevel": effort},
        },
    }
    j, served = _gemini(model, body, purpose)
    return json.loads(_gemini_text(j, purpose)), _gemini_usage(j), served


# ---- Anthropic ---------------------------------------------------------------------------------

_anthropic_client = None


def _anthropic():
    global _anthropic_client
    if _anthropic_client is None:
        import anthropic
        # Explicit base URL: never inherit ANTHROPIC_BASE_URL from a surrounding tool's proxy.
        _anthropic_client = anthropic.Anthropic(
            base_url=os.environ.get("FINN_ANTHROPIC_BASE_URL", "https://api.anthropic.com"), max_retries=3)
    return _anthropic_client


def _anthropic_json(model, system, documents, prompt, schema, effort, max_tokens, purpose):
    content = [{"type": "text", "text": d} for d in documents or []]
    if content:
        content[-1]["cache_control"] = {"type": "ephemeral"}  # repeat questions re-read docs from cache
    content.append({"type": "text", "text": prompt})
    kwargs = dict(max_tokens=max_tokens, system=system, messages=[{"role": "user", "content": content}],
                  output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}})
    c = _anthropic()
    if model in ANTHROPIC_FALLBACK_MODELS:
        response = c.beta.messages.create(model=model, betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
    else:
        response = c.messages.create(model=model, **kwargs)
    if response.stop_reason == "refusal":
        raise LLMError(f"{purpose}: model declined ({getattr(response.stop_details, 'category', None)})")
    if response.stop_reason == "max_tokens":
        raise LLMError(f"{purpose}: output truncated")
    u = response.usage
    usage = {"in": u.input_tokens, "out": u.output_tokens, "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0,
             "cache_write": getattr(u, "cache_creation_input_tokens", 0) or 0}
    return json.loads("".join(b.text for b in response.content if b.type == "text")), usage, response.model


# ---- public API --------------------------------------------------------------------------------

def complete_json(conn: sqlite3.Connection, *, purpose: str, tier: str, system: str, prompt: str, schema: dict,
                  documents: list[str] | None = None, effort: str = "low", max_tokens: int = 8000) -> dict:
    """One structured call, cached. `documents` go first so prompt-prefix caching can reuse them."""
    p, model = provider(), model_for(tier)
    key = _key(p, model, system, prompt, schema, documents)
    if (hit := _cached(conn, key)) is not None:
        return hit
    fn = _gemini_json if p == "gemini" else _anthropic_json
    result, usage, served = fn(model, system, documents, prompt, schema, effort, max_tokens, purpose)
    _store(conn, key, served, purpose, result, usage)
    log.info("%s via %s: %s in / %s out tokens", purpose, served, usage["in"], usage["out"])
    return result


def spend(conn: sqlite3.Connection) -> dict:
    rows = conn.execute(
        "SELECT model, purpose, COUNT(*) n, SUM(in_tokens) in_tokens, SUM(out_tokens) out_tokens, SUM(cost_usd) usd "
        "FROM llm_cache GROUP BY model, purpose ORDER BY n DESC"
    ).fetchall()
    return {"provider": provider(), "total_usd": round(sum(r["usd"] or 0 for r in rows), 4),
            "calls": sum(r["n"] for r in rows), "by_purpose": [dict(r) for r in rows]}
