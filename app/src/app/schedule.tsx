import { useLocalSearchParams } from "expo-router";
import { ScheduleEdit, type ScheduleSpec } from "../pages/ScheduleEdit";
import { payloadOf } from "../ui/page";
import { Gone } from "../ui/gone";
export default function ScheduleRoute() {
  const { k } = useLocalSearchParams();
  const p = payloadOf<ScheduleSpec>(k);
  return p ? <ScheduleEdit spec={p} /> : <Gone />;
}
