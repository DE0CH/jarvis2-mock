import { useLocalSearchParams } from "expo-router";
import { Transcript, type TranscriptSpec } from "../pages/Transcript";
import { payloadOf } from "../ui/page";
import { Gone } from "../ui/gone";
export default function TranscriptRoute() {
  const { k } = useLocalSearchParams();
  const p = payloadOf<TranscriptSpec>(k);
  return p ? <Transcript spec={p} /> : <Gone />;
}
