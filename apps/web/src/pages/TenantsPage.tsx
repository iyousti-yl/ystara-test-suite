import { useState } from "react";
import { Button, Dialog, Form, FormItem, Input, Label, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow } from "@ui5/webcomponents-react";
import { useNavigate } from "react-router";
import { useCan, useCreateTenant, useTenants } from "../api";
import { ErrorStrip, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";

/** Home: every tenant, and adding one by its Datasphere URL. */
export function TenantsPage() {
  const tenants = useTenants();
  const can = useCan();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);

  return (
    <div className="page">
      <PageHeader
        title="Tenants"
        subtitle="Datasphere tenants Ystara reads from. Read-only: it only lists and reads object definitions."
        actions={
          can("tenant.connect") && (
            <Button design="Emphasized" icon="add" onClick={() => setAdding(true)}>
              Add tenant
            </Button>
          )
        }
      />
      <ErrorStrip error={tenants.error} />
      {tenants.isPending ? (
        <Loading />
      ) : (
        <Table
          noDataText="No tenants yet. Add one, or load a saved scan with `npm run db:import`."
          onRowClick={(e) => navigate(`/tenants/${e.detail.row.rowKey}`)}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Datasphere URL</TableHeaderCell>
              <TableHeaderCell>Added</TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {tenants.data?.map((t) => (
            <TableRow key={t.id} rowKey={t.id} interactive>
              <TableCell>{t.name}</TableCell>
              <TableCell>{t.host ?? <span className="muted">None: imported scans only</span>}</TableCell>
              <TableCell>{formatDateTime(t.createdAt)}</TableCell>
            </TableRow>
          ))}
        </Table>
      )}
      {adding && <AddTenantDialog onClose={() => setAdding(false)} onAdded={(id) => navigate(`/tenants/${id}`)} />}
    </div>
  );
}

function AddTenantDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const create = useCreateTenant();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const submit = () => create.mutate({ name: name.trim(), host: host.trim() }, { onSuccess: (t) => onAdded(t.id) });

  return (
    <Dialog
      open
      headerText="Add a tenant"
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" onClick={submit} disabled={!name.trim() || !host.trim() || create.isPending}>
            Add
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <Form layout="S1 M1 L1 XL1" labelSpan="S12 M12 L12 XL12">
        <FormItem labelContent={<Label required>Name</Label>}>
          <Input value={name} onInput={(e) => setName(e.target.value)} placeholder="Partner tenant" />
        </FormItem>
        <FormItem labelContent={<Label required>Datasphere URL</Label>}>
          <Input value={host} onInput={(e) => setHost(e.target.value)} placeholder="https://your-tenant.eu10.hcs.cloud.sap" type="URL" />
        </FormItem>
      </Form>
      <ErrorStrip error={create.error} />
    </Dialog>
  );
}
