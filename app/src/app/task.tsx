import { useLocalSearchParams } from "expo-router";
import { TaskDetail } from "../pages/TaskDetail";
import { payloadOf } from "../ui/page";
import { Gone } from "../ui/gone";
export default function TaskRoute() {
  const { k } = useLocalSearchParams();
  const p = payloadOf<{ id: string }>(k);
  return p ? <TaskDetail id={p.id} /> : <Gone />;
}
