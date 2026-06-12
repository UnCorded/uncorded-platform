import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";
import "./index.css";
// Side-effect import: initializes the shell voice manager singleton at app
// entry, outside any component scope. See pr-5-voice-client-contract.md §15
// pin #7 — this is the foundation that lets voice survive panel and workspace
// remounts.
import "./lib/voice-manager";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

render(
  () => (
    // Single catch-all route: the Router exists only to host App; URL
    // interpretation (the /s/<server-slug> selection route) is owned by
    // lib/server-route.ts reading location directly. path="*" instead of an
    // enumerated list so an unmatched path can never blank the shell — with
    // only path="/", a cold boot at /s/<slug> matched nothing and the router
    // silently rendered NOTHING: black page, zero console output. Route
    // matching must never be able to take the app down; a weird URL should
    // degrade to "nothing selected", not to an empty render.
    <Router>
      <Route path="*" component={App} />
    </Router>
  ),
  root,
);
