import AgentProbe from "./components/AgentProbe";
import VmStatusPill from "./components/VmStatusPill";

import "./App.css";

function App() {
  return (
    <main className="container">
      <VmStatusPill />
      <AgentProbe />
    </main>
  );
}

export default App;
