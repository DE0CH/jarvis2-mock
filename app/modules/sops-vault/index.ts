// The phone's Secure Enclave vault key (ios/SopsVaultModule.swift). Null on the web and wherever the
// native module isn't built in.
import { requireOptionalNativeModule } from "expo";

type Vault = {
  isAvailable(): boolean;
  recipient(): string | null;
  createKey(): Promise<string>;
  deleteKey(): Promise<void>;
  decrypt(reason: string, prefix: string, values: Record<string, string>, age: { recipient: string; enc: string }[]): Promise<Record<string, string>>;
};
export const vault = requireOptionalNativeModule<Vault>("SopsVault");
