"""Rule-based announcement classifier.

Exchange subjects are a strong hint but not enough: NSE files CEO changes, subsidiary IPOs and
results decks under "General Updates". So rules match the subject AND the one-line text, and
text-specific rules run first. Anything still unmatched under a generic subject is flagged
`needs_llm` for the cheap-model pass, instead of sending every filing to a model.

Categories follow the reference document.
"""
import re
from dataclasses import dataclass

GENERIC_SUBJECTS = re.compile(
    r"^(general updates|updates|outcome of board meeting|press release|copy of newspaper publication|"
    r"corrigendum|resignation|appointment|committee meeting updates)$", re.I)


@dataclass(frozen=True)
class Rule:
    category: str
    text: str | None = None      # regex on subject + text
    subject: str | None = None   # regex on subject only
    weight: int | None = None    # override the category's base importance
    tag: str | None = None       # short machine-readable detail, e.g. "ceo", "ncd"


# Order matters: first match wins. Specific text patterns before broad subject patterns.
RULES = [
    # -- routine paperwork that would otherwise match broader rules below
    Rule("unclassified", text=r"newspaper|clipping|special window|physical shares", weight=3, tag="newspaper"),
    Rule("unclassified", text=r"trading window", weight=2, tag="trading_window"),
    Rule("unclassified", text=r"regulation 74\(5\)|reconciliation of share capital|depositories and participants", weight=1, tag="compliance"),
    Rule("unclassified", text=r"esg (rating|overview|report)|business responsibility", weight=5, tag="esg"),
    Rule("unclassified", text=r"monitoring agency|corrigendum|amendment to (aoa|moa)|kanto regional", weight=4),
    Rule("unclassified", text=r"esop|esos|esps|stock option|grant of .* options|allotment of [\d,]+ +shares|restricted stock",
         weight=4, tag="esop"),

    Rule("unclassified", text=r"guarantee|indemnity|letter of comfort|committee meeting|intimation under", weight=6),

    # -- subsidiary listings read like results notices ("board of JPL to consider ...")
    Rule("M&A", text=r"initial public offer|trading in equity shares of .* will commence|red herring", tag="deal"),

    # -- results and the documents that travel with them. Calls and transcripts often mention
    # "financial results", and results-date notices mention "unaudited", so both go first.
    Rule("earnings_call", text=r"transcript", weight=30, tag="transcript"),
    Rule("earnings_call", text=r"earnings (conference )?call|con(ference)?\.? call|post earnings|link of recording|"
                              r"audio recording|call with media", weight=15),
    Rule("earnings_call", text=r"investor presentation|analyst presentation|earnings presentation|\bpresentation\b",
         weight=20, tag="presentation"),
    Rule("results", text=r"to announce .*results|board meeting intimation .*results|scheduled .* to consider",
         weight=30, tag="results_date"),
    Rule("results", text=r"financial results|unaudited|audited .*results|interim condensed|results for the (quarter|period)|"
                        r"quarterly update|shareholders? letter|report of auditors on financial", tag="results"),
    Rule("investor_meetings", text=r"schedule of (investor )?meet|investor conference|analyst.*meet|investor.*meet|ndr",
         weight=10),

    # -- management
    Rule("management_change", text=r"independent director", weight=45, tag="independent"),
    Rule("management_change", text=r"\b(managing director|md ?(&|and) ?ceo|chief executive|ceo|cfo|chief financial|"
                                  r"whole[- ]time director|chairman|chairperson)\b", weight=90, tag="top"),
    Rule("management_change", text=r"resignation of (statutory )?auditor", weight=70, tag="auditor"),
    Rule("management_change", subject=r"change in management|change in director|resignation|appointment|cessation|demise",
         tag="unknown_role"),

    # -- corporate actions and capital. Setting up / winding down a wholly owned subsidiary is
    # housekeeping even when NSE files it under "Acquisition".
    Rule("M&A", text=r"incorporat\w* .*wholly[- ]owned|wholly[- ]owned .*incorporat|strike[- ]off", weight=25,
         tag="subsidiary_admin"),
    Rule("M&A", text=r"initial public offer|ipo of|demerger|merger|amalgamation|takeover|open offer|scheme of arrangement|"
                    r"majority stake|acquisition|acquire|joint venture|divest|sale of (stake|shares)|disposal", tag="deal"),
    Rule("M&A", subject=r"acquisition|sale or disposal|scheme of arrangement|agreements"),
    Rule("fund_raise", text=r"non[- ]convertible|ncd|commercial paper|debentures", weight=20, tag="debt"),
    Rule("fund_raise", text=r"qualified institution|\bqip\b|preferential|rights issue|buy-?back|capital raise|issue of securities",
         tag="equity"),
    Rule("fund_raise", subject=r"allotment of securities|issue of securities|preferential issue|qualified institutional placement|"
                               r"buyback"),
    Rule("pledging", text=r"pledge|encumbrance"),
    Rule("insider_trading", subject=r"insider trading|sast|acquisition of shares by promoter"),
    Rule("insider_trading", text=r"regulation 7\(2\)|regulation 29\(2\)|promoter.*(purchase|sale|bought|sold)"),
    Rule("litigation", text=r"\bnclt\b|\bnclat\b|insolvency|litigation|dispute|court|tribunal|penalty|fine levied|"
                          r"show cause|order passed|orders passed|sebi order|gst demand|tax demand", tag="legal"),
    Rule("credit_rating", text=r"credit rating|rating", tag="rating"),
    Rule("dividend", text=r"dividend"),
    Rule("bonus_split", text=r"bonus|sub-?division|stock split|split of"),
    Rule("capex", text=r"capex|capacity expansion|new (plant|facility|unit)|commencement of commercial production|greenfield|brownfield"),
    Rule("postal_ballot", text=r"postal ballot"),
    Rule("agm_egm", text=r"general meeting|\bagm\b|\begm\b|scrutini[sz]er"),
    Rule("press_release", text=r"order|contract|bagging", weight=50, tag="order_win"),
    Rule("press_release", subject=r"press release|updates|general updates|media"),
]

# Base importance (0-100) by category, before price reaction and user preferences.
BASE_WEIGHT = {
    "results": 85, "management_change": 60, "M&A": 75, "fund_raise": 65, "litigation": 60,
    "pledging": 75, "insider_trading": 55, "credit_rating": 45, "capex": 65, "dividend": 35,
    "bonus_split": 55, "press_release": 30, "earnings_call": 20, "investor_meetings": 10,
    "agm_egm": 15, "postal_ballot": 15, "unclassified": 5,
}


BOILERPLATE = re.compile(
    r"^.*?\b(has|have)\s+(informed|submitted|filed)\s+(to\s+|with\s+)?(the\s+)?exchanges?\s*,?\s*"
    r"(about|regarding|that|on|for)?\s*(the\s+)?|^we wish to inform that\s+", re.I)


REG30 = re.compile(r"^(disclosure|intimation|information)\s+under\s+regulation\s+30.*?regulations?,?\s*2015\s*"
                   r"(r/w\s+\S+\s*)?[-–:]?\s*", re.I)


def tidy(text: str | None) -> str:
    """'Infosys Limited has informed the Exchange regarding 'X'.' -> 'X'"""
    t = BOILERPLATE.sub("", (text or "").strip()).strip(" .'\"")
    t = REG30.sub("", t).strip(" .'\"")
    t = re.sub(r"\s+", " ", t)
    return t[:1].upper() + t[1:] if t else ""


@dataclass
class Classification:
    category: str
    weight: int
    tag: str | None
    needs_llm: bool  # subject was generic and nothing specific matched: let a cheap model decide


def classify(subject: str | None, text: str | None) -> Classification:
    subject = (subject or "").strip()
    haystack = f"{subject} || {text or ''}"
    for rule in RULES:
        if rule.subject and not re.search(rule.subject, subject, re.I):
            continue
        if rule.text and not re.search(rule.text, haystack, re.I):
            continue
        weight = rule.weight if rule.weight is not None else BASE_WEIGHT[rule.category]
        # A broad subject-only fallback under a generic subject is a guess; flag it.
        guess = rule.text is None and bool(GENERIC_SUBJECTS.match(subject))
        return Classification(rule.category, weight, rule.tag, needs_llm=guess)
    return Classification("unclassified", BASE_WEIGHT["unclassified"], None, needs_llm=True)
