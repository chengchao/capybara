import { createContext, useContext } from "react";

// Lets a deeply-nested ConsentCard answer a prompt without threading a callback
// through Transcript/AssistantTurn. ChatApp provides the responder.
export type ConsentResponder = (requestId: string, decision: "allow" | "deny") => void;

const ConsentContext = createContext<ConsentResponder>(() => {});

export const ConsentProvider = ConsentContext.Provider;
export const useConsent = () => useContext(ConsentContext);
