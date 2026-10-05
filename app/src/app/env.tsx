import { useLocalSearchParams } from "expo-router";
import { EnvEditor } from "../pages/EnvEditor";
import { payloadOf } from "../ui/page";
import { Gone } from "../ui/gone";
export default function EnvRoute() {
  const { k } = useLocalSearchParams();
  const p = payloadOf<{ name: string }>(k);
  return p ? <EnvEditor name={p.name} /> : <Gone />;
}
