import { useLocalSearchParams } from "expo-router";
import { Remote, type RemoteSpec } from "../pages/Remote";
import { payloadOf } from "../ui/page";
import { Gone } from "../ui/gone";
export default function RemoteRoute() {
  const { k } = useLocalSearchParams();
  const p = payloadOf<RemoteSpec>(k);
  return p ? <Remote spec={p} /> : <Gone />;
}
