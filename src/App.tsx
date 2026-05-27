import AgentProbe from "./components/AgentProbe";
import Settings from "./components/Settings";
import VmStatusPill from "./components/VmStatusPill";

function App() {
  return (
    <main className="flex min-h-screen flex-col items-center gap-4 px-4 pt-[10vh] text-center">
      <Settings />
      <VmStatusPill />
      <AgentProbe />
    </main>
  );
}

export default App;
