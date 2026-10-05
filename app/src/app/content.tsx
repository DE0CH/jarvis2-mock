import { useLocalSearchParams } from "expo-router";
import { ContentStorePage } from "../pages/ContentStore";
import { payloadOf } from "../ui/page";
import { Gone } from "../ui/gone";
export default function ContentRoute() {
  const { k } = useLocalSearchParams();
  const p = payloadOf<{ name: string }>(k);
  return p ? <ContentStorePage name={p.name} /> : <Gone />;
}
