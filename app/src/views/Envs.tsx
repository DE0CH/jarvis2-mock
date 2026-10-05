import { api } from "../lib/api";
import { useStore, pendUntil, ask } from "../lib/store";
import { Button, Card, Flex, Heading, Muted, P } from "../ui/kit";
import { PButton, useCoolAfterShift } from "../ui/bits";
import { Cards } from "../ui/cards";

export function Envs({ onEdit }: { onEdit: (name: string) => void }) {
  const envs = useStore((s) => s.state.environments) || {};
  const pending = useStore((s) => s.pending);
  const names = Object.keys(envs).sort();
  const cool = useCoolAfterShift(names.join("|"));
  async function del(n: string) {
    if (!(await ask({ title: `Delete environment "${n}"?`, detail: "Its saved secret values are removed from the cluster and from git — nothing outside is affected.", action: "Delete environment", danger: true }))) return;
    // pending until the list no longer has it: never a moment where the card looks deletable again
    await pendUntil("env:" + n, "Deleting…", () => api("DELETE", "api/environments/" + encodeURIComponent(n)), (s) => !(n in (s.environments || {})));
  }
  return (
    <>
      <Cards>
        {names.map((n) => { const d = envs[n]; return (
          <Card key={n} dim={pending.has("env:" + n)} data={{ env: n }}>
            <Flex justify="space-between" align="flex-start" gap={2} mb={1}><Heading size={3} style={{ flex: 1 }}>{n}</Heading><P size={1} color="gray">{(d.keys || []).length} keys</P></Flex>
            <Muted>{(d.keys || []).join(", ") || "—"}</Muted>
            <Flex gap={2} pt={3} style={{ marginTop: "auto" }}><Button variant="soft" color="gray" onPress={() => onEdit(n)}>Edit secrets</Button><PButton pkey={"env:" + n} color="red" variant="soft" onPress={() => del(n)} label="Delete" cool={cool} /></Flex>
          </Card>); })}
      </Cards>
      <Button id="env-add" style={{ marginTop: 12 }} onPress={() => onEdit("")}>+ Add environment</Button>
    </>
  );
}
