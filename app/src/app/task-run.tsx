import { useLocalSearchParams } from "expo-router";
import { TaskRun } from "../pages/TaskRun";
import { payloadOf } from "../ui/page";
import { Gone } from "../ui/gone";
export default function TaskRunRoute() {
  const { k } = useLocalSearchParams();
  const p = payloadOf<{ name: string; title: string }>(k);
  return p ? <TaskRun name={p.name} title={p.title} /> : <Gone />;
}
