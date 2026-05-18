import { createContext, useContext } from "react";

export type RuntimeIdentity = {
  conversationId: string;
  title: string;
  brand: string;
  subtitle: string;
  timezone: string;
  selfLabel: string;
  selfShortLabel: string;
  counterpartLabel: string;
  counterpartShortLabel: string;
};

export const FALLBACK_RUNTIME_IDENTITY: RuntimeIdentity = {
  conversationId: "conversation",
  title: "Conversation Explorer",
  brand: "conversation explorer",
  subtitle: "a private conversation, observed",
  timezone: "America/Vancouver",
  selfLabel: "Me",
  selfShortLabel: "Me",
  counterpartLabel: "Them",
  counterpartShortLabel: "Them",
};

export const RuntimeIdentityContext = createContext<RuntimeIdentity>(FALLBACK_RUNTIME_IDENTITY);

export function useRuntimeIdentity(): RuntimeIdentity {
  return useContext(RuntimeIdentityContext);
}

export function senderLabel(identity: RuntimeIdentity, sender: "me" | "them" | "both" | undefined): string {
  if (sender === "me") return identity.selfLabel;
  if (sender === "them") return identity.counterpartLabel;
  return "Both";
}

export function senderShortLabel(identity: RuntimeIdentity, sender: "me" | "them" | "both" | undefined): string {
  if (sender === "me") return identity.selfShortLabel;
  if (sender === "them") return identity.counterpartShortLabel;
  return "Both";
}
