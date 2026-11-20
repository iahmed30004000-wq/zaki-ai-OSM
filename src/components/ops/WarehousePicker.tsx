'use client';

import React, { useCallback, useState } from 'react';
import Link from 'next/link';
import { Select } from '@/components/ui/Input';

/**
 * «من أي مخزن؟» — THE ONE WAREHOUSE PICKER OF THE SHIPPING SCREENS (the warehouse plan, W4c).
 *
 * «التجهيز», «إنشاء شحنة» and «دفعات الشحن» draw it for a store whose stock is PLACED in warehouses, and only then: the
 * list each screen reads carries `warehouses` for such a store (`shipment-warehouse.shipmentWarehouseChoices` — the
 * running warehouses of the store's country that this person reaches) and carries nothing for any other store. No field,
 * no picker, no parameter: an unplaced store's screens look and ask exactly as they did.
 *
 * THE CHOICE:
 *   - one warehouse offered → it is chosen, and there is nothing to pick;
 *   - several → the last one this person picked ON THIS DEVICE, if it is still offered; otherwise none yet;
 *   - none offered → the store is placed but she reaches no warehouse of it: said in a sentence, nothing to pick.
 *
 * THE MEMORY IS A CONVENIENCE, NEVER THE TRUTH. It lives in the browser, per person, and is only ever compared with the
 * list the server just sent: a remembered warehouse that was stopped or taken from her is simply not chosen. Every read
 * and write is wrapped, so a private window or blocked storage changes nothing but the convenience.
 */

export interface OpsWarehouse {
  id: string;
  name: string;
}

const KEY = 'ops-warehouse:';

function remembered(userId: string | null | undefined): string | null {
  if (!userId) return null;
  try {
    return window.localStorage.getItem(KEY + userId);
  } catch {
    return null;
  }
}

function remember(userId: string | null | undefined, warehouseId: string) {
  if (!userId) return;
  try {
    if (warehouseId) window.localStorage.setItem(KEY + userId, warehouseId);
    else window.localStorage.removeItem(KEY + userId);
  } catch {
    /* storage refused: the choice still holds for this visit */
  }
}

/** Which warehouse a list starts on: the only one, else the remembered one if it is still offered, else none. */
export function firstChoice(warehouses: readonly OpsWarehouse[] | null, rememberedId: string | null): string {
  if (!warehouses || warehouses.length === 0) return '';
  if (warehouses.length === 1) return warehouses[0].id;
  return rememberedId && warehouses.some((w) => w.id === rememberedId) ? rememberedId : '';
}

/**
 * The picker's state for one screen. `heard` is given the `warehouses` field of every answer of the screen's list
 * (absent = the store is not placed); `place` is the chosen id ('' = none); `choose` is the person's pick.
 */
export function useOpsWarehouse(userId: string | null | undefined) {
  const [warehouses, setWarehouses] = useState<OpsWarehouse[] | null>(null);
  const [place, setPlace] = useState('');

  const heard = useCallback(
    (list: unknown) => {
      const offered = Array.isArray(list) ? (list as OpsWarehouse[]) : null;
      setWarehouses(offered);
      setPlace((current) =>
        offered === null ? '' : current && offered.some((w) => w.id === current) ? current : firstChoice(offered, remembered(userId))
      );
    },
    [userId]
  );

  const choose = useCallback(
    (warehouseId: string) => {
      setPlace(warehouseId);
      remember(userId, warehouseId);
    },
    [userId]
  );

  return { warehouses, place, heard, choose };
}

/** What the screen says when the store is placed and this person reaches none of its warehouses. */
export const NO_WAREHOUSE_AR = 'هالمتجر موزّع على مخازن، وما إلك وصول على ولا مخزن منها. اطلب من صاحب الشغل يعطيك مخزن.';

export function WarehousePicker({
  warehouses,
  value,
  onChange,
  label,
  noneLabel,
}: {
  warehouses: readonly OpsWarehouse[];
  value: string;
  onChange: (warehouseId: string) => void;
  label: string;
  /** The empty option's words («اختار المخزن», «كل المخازن»). Not drawn when only one warehouse is offered. */
  noneLabel: string;
}) {
  if (warehouses.length === 0) {
    return <p className="text-sm text-[var(--sys-destructive)]">{NO_WAREHOUSE_AR}</p>;
  }
  return (
    <Select
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={[
        ...(warehouses.length === 1 ? [] : [{ value: '', label: noneLabel }]),
        ...warehouses.map((w) => ({ value: w.id, label: w.name })),
      ]}
    />
  );
}

/**
 * THE WAY ON FROM A SHORTAGE IN ONE WAREHOUSE: a new transfer (`/inventory/transfers`, the warehouse plan W3b). The
 * shortage sentence says which warehouse holds the units (`shipment-warehouse.warehouseShortageAr`); this is the press
 * beside it. Drawn by the screens only for a placed store with a warehouse chosen, to a holder of the transfer key.
 */
export function TransferLink() {
  return (
    <Link href="/inventory/transfers" className="font-bold underline">
      انقل بضاعة بين المخازن
    </Link>
  );
}
