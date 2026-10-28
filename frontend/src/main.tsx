import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { Brief } from "./Brief";
import { Company } from "./Company";
import { Alerts, Portfolio, Research } from "./Screens";
import "./styles.css";

function useRoute(): [string, (p: string) => void] {
  const read = () => location.hash.replace(/^#/, "") || "/";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => { setRoute(read()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((p: string) => { location.hash = p; }, []);
  return [route, go];
}

/** Checks for new alerts when the app is opened or refocused, and raises a system notification. */
function useAlertNotifications() {
  useEffect(() => {
    const check = async () => {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      const alerts = await api.alerts().catch(() => []);
      let seen: string[] = [];
      try { seen = JSON.parse(localStorage.getItem("finn.notified") || "[]"); } catch { /* ignore */ }
      const fresh = alerts.filter((a) => !a.seen && !seen.includes(a.id)).slice(0, 3);
      const reg = await navigator.serviceWorker?.getRegistration();
      for (const a of fresh) {
        const opts = { body: a.title, tag: a.id, icon: "/icon.svg", data: { url: `/#/c/${a.symbol}` } };
        if (reg) reg.showNotification(`FINN · ${a.symbol}`, opts); else new Notification(`FINN · ${a.symbol}`, opts);
      }
      try { localStorage.setItem("finn.notified", JSON.stringify([...seen, ...fresh.map((a) => a.id)].slice(-200))); } catch { /* ignore */ }
    };
    check();
    const onVis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
}

const TABS = [
  { path: "/", label: "Brief", icon: "M4 6h16M4 12h10M4 18h7" },
  { path: "/portfolio", label: "Portfolio", icon: "M4 19V9m6 10V5m6 14v-7m4 7H3" },
  { path: "/research", label: "Research", icon: "M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Zm5.5-2 5 5" },
  { path: "/alerts", label: "Alerts", icon: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Zm4 4h4" },
];

function App() {
  const [route, go] = useRoute();
  useAlertNotifications();
  const company = route.match(/^\/c\/([A-Za-z0-9&-]+)/);
  let screen;
  if (company) screen = <Company key={company[1]} symbol={company[1].toUpperCase()} go={go} />;
  else if (route === "/portfolio") screen = <Portfolio go={go} />;
  else if (route === "/research") screen = <Research go={go} />;
  else if (route === "/alerts") screen = <Alerts go={go} />;
  else screen = <Brief go={go} />;
  const active = company ? "/research" : route;
  return (
    <>
      <main>{screen}</main>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.path} href={`#${t.path}`} className={active === t.path ? "on" : ""} aria-current={active === t.path ? "page" : undefined}>
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden><path d={t.icon} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span>{t.label}</span>
          </a>
        ))}
      </nav>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}
