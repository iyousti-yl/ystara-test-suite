import { useState } from "react";
import { Button, Dialog, Form, FormItem, Input, Label, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow } from "@ui5/webcomponents-react";
import { useNavigate } from "react-router";
import { useCan, useCreateTenant, useTenants } from "../api";
import { EmptyState } from "../components/EmptyState";
import { ErrorStrip, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";

/** Tenants: every tenant of the account, and adding one by its Datasphere URL (then its Connect wizard opens). Opening one picks it. */
export function TenantsPage() {
  const tenants = useTenants();
  const can = useCan();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const addButton = can("tenant.connect") && (
    <Button design="Emphasized" icon="add" onClick={() => setAdding(true)}>
      Add tenant
    </Button>
  );

  return (
    <div className="page">
      <PageHeader
        title="Tenants"
        subtitle="The Datasphere tenants Ystara reads from: it lists and reads their objects, and changes nothing."
        actions={tenants.data?.length ? addButton : undefined}
      />
      <ErrorStrip error={tenants.error} />
      {tenants.isPending ? (
        <Loading />
      ) : tenants.data?.length === 0 ? (
        <EmptyState icon="it-system" title="No tenants yet" action={addButton}>
          {can("tenant.connect")
            ? "Add a Datasphere tenant by its URL, then connect it to scan its spaces and test its pipelines."
            : "An admin adds the account's Datasphere tenants. Once one is added, it shows here."}
        </EmptyState>
      ) : (
        <Table
          overflowMode="Popin"
          onRowClick={(e) => navigate(`/tenants/${e.detail.row.rowKey}`)}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell minWidth="10rem" importance={1}>
                Name
              </TableHeaderCell>
              <TableHeaderCell minWidth="14rem" importance={1}>
                Datasphere URL
              </TableHeaderCell>
              <TableHeaderCell minWidth="10rem">Added</TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {tenants.data?.map((t) => (
            <TableRow key={t.id} rowKey={t.id} interactive>
              <TableCell>{t.name}</TableCell>
              <TableCell className="wrap-anywhere">{t.host ?? <span className="muted">None: imported scans only</span>}</TableCell>
              <TableCell>{formatDateTime(t.createdAt)}</TableCell>
            </TableRow>
          ))}
        </Table>
      )}
      {adding && <AddTenantDialog onClose={() => setAdding(false)} onAdded={(id) => navigate(`/tenants/${id}/connection?connect=1`)} />}
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
