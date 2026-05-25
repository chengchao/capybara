import { Button } from "@/components/ui/button";

import AgentProbe from "./components/AgentProbe";
import VmStatusPill from "./components/VmStatusPill";

function App() {
  return (
    <main className="flex min-h-screen flex-col items-center gap-4 px-4 pt-[10vh] text-center">
      <VmStatusPill />
      <AgentProbe />
      <Button>shadcn/ui is wired up</Button>
    </main>
  );
}

export default App;
