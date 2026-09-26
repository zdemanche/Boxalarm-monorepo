import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  DataTable,
  Skeleton,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { createInventoryItem, getInventory, updateInventoryQuantity } from './api';
import type { CompartmentItem, CreateInventoryItemInput } from './types';

const emptyForm: CreateInventoryItemInput = { compartmentCode: '', itemName: '', quantity: 1 };

// Takes the apparatus's apparatusId (not its display unitId) — matches ApparatusDetailPage's
// own detail fetch and the real backend's inventory endpoints, which key directly on
// apparatusId (apparatus-service inventory/compartmentItemRepository.ts).
export function InventoryTab({ apparatusId }: { apparatusId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [quantityError, setQuantityError] = useState<{ itemId: string; message: string } | null>(
    null,
  );
  // Bumped on a failed save so the uncontrolled quantity input remounts with the last
  // persisted value instead of keeping the unsaved number on screen.
  const [quantityResetNonce, setQuantityResetNonce] = useState(0);

  const query = useQuery({
    queryKey: ['apparatus', apparatusId, 'inventory'],
    queryFn: () => getInventory(auth, apparatusId),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateInventoryItemInput) => createInventoryItem(auth, apparatusId, input),
    onSuccess: () => {
      setForm(emptyForm);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', apparatusId, 'inventory'] });
    },
  });

  const quantityMutation = useMutation({
    mutationFn: (input: { itemId: string; quantity: number }) =>
      updateInventoryQuantity(auth, apparatusId, input.itemId, input.quantity),
    onSuccess: () => {
      setQuantityError(null);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', apparatusId, 'inventory'] });
    },
    onError: (error: Error, input) => {
      setQuantityError({
        itemId: input.itemId,
        message: `Quantity not saved: ${error.message}`,
      });
      setQuantityResetNonce((n) => n + 1);
    },
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const columns: DataTableColumn<CompartmentItem>[] = [
    { key: 'itemName', header: 'Item', sortValue: (i) => i.itemName, render: (i) => i.itemName },
    {
      key: 'quantity',
      header: 'Quantity',
      sortValue: (i) => i.quantity,
      render: (i) => (
        <TextInput
          key={`${i.itemId}-${quantityResetNonce}`}
          label={`Quantity for ${i.itemName}`}
          type="number"
          min="0"
          defaultValue={i.quantity}
          error={quantityError?.itemId === i.itemId ? quantityError.message : undefined}
          style={{ width: 80 }}
          onBlur={(e) => {
            const quantity = Number(e.target.value);
            if (Number.isInteger(quantity) && quantity !== i.quantity) {
              quantityMutation.mutate({ itemId: i.itemId, quantity });
            }
          }}
        />
      ),
    },
  ];

  return (
    <section>
      <h2 style={{ fontSize: 17, fontWeight: 600 }}>Compartment inventory</h2>
      {query.isLoading ? (
        <Skeleton lines={3} />
      ) : (query.data ?? []).length === 0 ? (
        <p>No inventory recorded for this unit.</p>
      ) : (
        (query.data ?? []).map((group) => (
          <Card
            key={group.compartmentCode}
            title={group.compartmentCode}
            style={{ marginTop: 'var(--bx-space-md)' }}
          >
            <DataTable
              caption={`${group.compartmentCode} inventory`}
              rowKey={(i) => i.itemId}
              columns={columns}
              rows={group.items}
              emptyMessage="No items in this compartment."
            />
          </Card>
        ))
      )}

      <Card title="Add item" style={{ marginTop: 'var(--bx-space-lg)', maxWidth: 480 }}>
        <form
          aria-label="Add inventory item"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            createMutation.mutate(form);
          }}
          style={{ display: 'grid', gap: 'var(--bx-space-sm)' }}
        >
          <TextInput
            label="Compartment"
            value={form.compartmentCode}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, compartmentCode: e.target.value }))}
          />
          <TextInput
            label="Item name"
            value={form.itemName}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, itemName: e.target.value }))}
          />
          <TextInput
            label="Quantity"
            type="number"
            min="0"
            value={form.quantity}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, quantity: Number(e.target.value) }))}
          />
          {createMutation.error ? <p role="alert">{createMutation.error.message}</p> : null}
          <Button type="submit" loading={createMutation.isPending} style={{ maxWidth: 240 }}>
            Add item
          </Button>
        </form>
      </Card>
    </section>
  );
}
