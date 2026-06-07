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
    <Router>
      <Route path="/" component={App} />
    </Router>
  ),
  root,
);
