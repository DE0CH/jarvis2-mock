import { useLocalSearchParams } from "expo-router";
import { TerminalPage } from "../pages/Terminal";
import { payloadOf } from "../ui/page";
import { Gone } from "../ui/gone";
export default function TerminalRoute() {
  const { k } = useLocalSearchParams();
  const p = payloadOf<{ id: string; title: string }>(k);
  return p ? <TerminalPage session={p} /> : <Gone />;
}
