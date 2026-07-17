import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Transferit, type TransferitOptions } from "@noxius/transferit";

const TransferitContext = createContext<Transferit | null>(null);

export interface TransferitProviderProps extends TransferitOptions {
  /** Inject an existing client (skips creating/closing one). */
  client?: Transferit;
  children: ReactNode;
}

export function TransferitProvider({
  client: injected,
  children,
  ...opts
}: TransferitProviderProps) {
  // Options apply only on first mount when owning the client.
  const [owned] = useState(() => (injected ? null : new Transferit(opts)));

  useEffect(() => {
    return () => {
      owned?.close();
    };
  }, [owned]);

  const client = injected ?? owned;
  if (!client) {
    throw new Error("TransferitProvider: missing client");
  }

  return createElement(
    TransferitContext.Provider,
    { value: client },
    children,
  );
}

export function useTransferit(): Transferit {
  const client = useContext(TransferitContext);
  if (!client) {
    throw new Error("useTransferit() requires <TransferitProvider>");
  }
  return client;
}
