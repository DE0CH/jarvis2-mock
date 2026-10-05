import { useLocalSearchParams } from "expo-router";
import { Relogin } from "../pages/Relogin";
import { payloadOf } from "../ui/page";
import { Gone } from "../ui/gone";
export default function ReloginRoute() {
  const { k } = useLocalSearchParams();
  const p = payloadOf<{ url: string }>(k);
  return p ? <Relogin url={p.url} /> : <Gone />;
}
