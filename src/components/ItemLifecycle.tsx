import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Item } from '../../shared/contracts';
import { api, jsonBody } from '../api';
import { ConfirmDialog, useToast } from './ui';

type LifecycleChange = { item: Item; action: 'archive' | 'restore' };

export function useItemLifecycle({
  onSuccess,
  onError,
}: {
  onSuccess?: (change: LifecycleChange) => void;
  onError?: (error: Error) => void;
} = {}) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ item, action }: LifecycleChange) =>
      api<void>(`/items/${item.id}/${action}`, { method: 'POST', body: jsonBody({}) }),
    onSuccess: async (_result, change) => {
      await client.invalidateQueries();
      toast(
        change.action === 'restore'
          ? 'Item restored.'
          : 'Item archived. Choose Archived items to find and restore it.',
      );
      onSuccess?.(change);
    },
    onError,
  });
}

export function ArchiveItemDialog({
  item,
  onConfirm,
  onClose,
  busy,
  error,
}: {
  item: Item | null;
  onConfirm(): void;
  onClose(): void;
  busy?: boolean;
  error?: string;
}) {
  return (
    <ConfirmDialog
      open={!!item}
      title={item ? `Archive ${item.name}?` : 'Archive item?'}
      description="The item will leave active inventory and its history will stay available. Stock must be zero. You can restore it from Archived items."
      confirmLabel="Archive item"
      onConfirm={onConfirm}
      onClose={onClose}
      busy={busy}
      error={error}
    />
  );
}
