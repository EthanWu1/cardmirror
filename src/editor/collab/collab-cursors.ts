/**
 * Presence cursors, room membership, and AI lease advertisements.
 *
 * The encrypted presence channel carries three frame types:
 *   0x01 cursor bytes for loro-prosemirror's ephemeral cursor plugin
 *   0x02 AI lease advertisements
 *   0x03 durable room membership heartbeats
 *
 * Cursor frames are allowed to be noisy and ephemeral. Membership frames are
 * the source of truth for avatars and "who is online", so a partner can keep
 * reading without their profile disappearing just because their caret did not
 * move.
 */

import { Plugin, PluginKey, Selection, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import { CursorEphemeralStore, LoroEphemeralCursorPlugin } from 'loro-prosemirror';
import type { PeerID } from 'loro-crdt';
import { settings } from '../settings.js';
import type { CollabSession } from './collab-session.js';
import { leasedRanges } from '../ai/edit-coordinator.js';

const FRAME_CURSOR = 0x01;
const FRAME_LEASE = 0x02;
const FRAME_MEMBER = 0x03;

const CURSOR_THROTTLE_MS = 50;
const KEEPALIVE_MS = 15_000;
const MEMBER_HEARTBEAT_MS = 5_000;
const MEMBER_THROTTLE_MS = 120;
const MEMBER_TTL_MS = 20_000;
const LEASE_MS = 2_000;
const STORE_TIMEOUT_MS = 45_000;

export function peerColor(peerId: string): string {
  let h = 0;
  for (const ch of peerId) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 70%, 45%)`;
}

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

interface LeaseAd {
  peer: string;
  name: string;
  ranges: { from: number; to: number; label: string }[];
}

interface MemberCursor {
  from: number;
  to: number;
  anchor: number;
  head: number;
}

interface MemberAd {
  peer: string;
  name: string;
  color?: string;
  cursor?: MemberCursor | null;
  leave?: boolean;
  at?: number;
}

interface RemoteMember {
  peer: string;
  name: string;
  color: string;
  cursor: MemberCursor | null;
  lastSeen: number;
}

const leaseAdsKey = new PluginKey<DecorationSet>('collab-lease-ads');

export interface CursorsHandle {
  plugins(): Plugin[];
  applyRemote(bytes: Uint8Array): boolean;
  visiblePeers(): string[];
  presence(): { peer: string; name: string; color: string; self: boolean }[];
  jumpToPeer(peer: string): boolean;
  dispose(): void;
}

export function installCursorPresence(
  session: CollabSession,
  getView: () => EditorView | null,
): CursorsHandle {
  const peerId = session.loroDoc.peerIdStr as PeerID;
  const store = new CursorEphemeralStore(peerId, STORE_TIMEOUT_MS);
  const remoteMembers = new Map<string, RemoteMember>();
  let disposed = false;

  const user = {
    name: settings.get('pairingDisplayName').trim() || 'Partner',
    color: peerColor(peerId),
  };

  function localCursor(): MemberCursor | null {
    const view = getView();
    if (!view || view.isDestroyed) return null;
    const sel = view.state.selection;
    const point = sel as { anchor?: unknown; head?: unknown };
    const anchor = typeof point.anchor === 'number' ? point.anchor : sel.from;
    const head = typeof point.head === 'number' ? point.head : sel.to;
    return {
      from: sel.from,
      to: sel.to,
      anchor,
      head,
    };
  }

  function normalizeCursor(value: unknown, docSize?: number): MemberCursor | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Partial<MemberCursor>;
    const nums = [v.from, v.to, v.anchor, v.head];
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    const max = typeof docSize === 'number' ? docSize : Number.MAX_SAFE_INTEGER;
    const clamp = (n: number): number => Math.max(0, Math.min(max, Math.round(n)));
    const from = clamp(v.from!);
    const to = clamp(v.to!);
    return {
      from: Math.min(from, to),
      to: Math.max(from, to),
      anchor: clamp(v.anchor!),
      head: clamp(v.head!),
    };
  }

  function memberFrame(ad: MemberAd): Uint8Array {
    return frame(FRAME_MEMBER, new TextEncoder().encode(JSON.stringify(ad)));
  }

  function sendMemberNow(leave = false): void {
    if (disposed && !leave) return;
    void session.sendPresence(
      memberFrame({
        peer: String(peerId),
        name: user.name,
        color: user.color,
        cursor: leave ? null : localCursor(),
        leave,
        at: Date.now(),
      }),
    );
  }

  let memberSendTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleMemberSend(): void {
    if (disposed || memberSendTimer !== null) return;
    memberSendTimer = setTimeout(() => {
      memberSendTimer = null;
      sendMemberNow();
    }, MEMBER_THROTTLE_MS);
  }

  function purgeStaleMembers(now = Date.now()): boolean {
    let changed = false;
    for (const [peer, member] of remoteMembers) {
      if (now - member.lastSeen > MEMBER_TTL_MS) {
        remoteMembers.delete(peer);
        changed = true;
      }
    }
    return changed;
  }

  function applyMemberAd(ad: MemberAd): boolean {
    const peer = typeof ad.peer === 'string' ? ad.peer : '';
    if (!peer || peer === peerId) return false;
    const before = remoteMembers.get(peer);
    if (ad.leave) {
      remoteMembers.delete(peer);
      return before != null;
    }
    const view = getView();
    const name = (typeof ad.name === 'string' && ad.name.trim()) || 'Partner';
    const color = (typeof ad.color === 'string' && ad.color.trim()) || peerColor(peer);
    remoteMembers.set(peer, {
      peer,
      name,
      color,
      cursor: normalizeCursor(ad.cursor, view?.state.doc.content.size),
      lastSeen: Date.now(),
    });
    return !before || before.name !== name || before.color !== color;
  }

  let cursorSendTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCursorBytes: Uint8Array | null = null;
  const unsubLocal = store.subscribeLocalUpdates((bytes: Uint8Array) => {
    if (disposed || !cursorsEnabled()) return;
    pendingCursorBytes = bytes;
    scheduleMemberSend();
    cursorSendTimer ??= setTimeout(() => {
      cursorSendTimer = null;
      if (pendingCursorBytes && !disposed) {
        void session.sendPresence(frame(FRAME_CURSOR, pendingCursorBytes));
      }
      pendingCursorBytes = null;
    }, CURSOR_THROTTLE_MS);
  });

  const cursorKeepalive = setInterval(() => {
    if (disposed || !cursorsEnabled()) return;
    const local = store.getLocal();
    if (local) store.setLocal(local);
  }, KEEPALIVE_MS);

  const memberHeartbeat = setInterval(() => {
    if (!disposed) sendMemberNow();
  }, MEMBER_HEARTBEAT_MS);
  setTimeout(() => sendMemberNow(), 0);

  let lastLeaseCount = 0;
  const leaseTimer = setInterval(() => {
    if (disposed) return;
    const view = getView();
    if (!view) return;
    const ranges = leasedRanges(view.state).map((r) => ({ ...r, label: 'AI' }));
    if (ranges.length === 0 && lastLeaseCount === 0) return;
    lastLeaseCount = ranges.length;
    const ad: LeaseAd = { peer: peerId, name: user.name, ranges };
    void session.sendPresence(frame(FRAME_LEASE, new TextEncoder().encode(JSON.stringify(ad))));
  }, LEASE_MS);

  const applyLeaseAd = (ad: LeaseAd): void => {
    if (ad.peer === peerId) return;
    const view = getView();
    if (!view || view.isDestroyed) return;
    const who = (ad.name || 'Partner').trim() || 'Partner';
    const decos = ad.ranges
      .filter((r) => r.from >= 0 && r.to > r.from && r.to <= view.state.doc.content.size)
      .flatMap((r) => [
        Decoration.inline(r.from, r.to, { class: 'pmd-collab-lease-ad' }),
        Decoration.widget(r.from, () => {
          const tag = document.createElement('span');
          tag.className = 'pmd-collab-lease-ad-tag';
          tag.textContent = `* ${who}'s ${r.label}`;
          return tag;
        }),
      ]);
    const tr = view.state.tr.setMeta(leaseAdsKey, DecorationSet.create(view.state.doc, decos));
    view.dispatch(tr);
  };

  const memberPresencePlugin = new Plugin<null>({
    key: new PluginKey<null>('collab-member-presence'),
    state: {
      init: () => null,
      apply(tr, value) {
        if (tr.docChanged) {
          for (const member of remoteMembers.values()) {
            if (!member.cursor) continue;
            member.cursor = {
              from: tr.mapping.map(member.cursor.from),
              to: tr.mapping.map(member.cursor.to),
              anchor: tr.mapping.map(member.cursor.anchor),
              head: tr.mapping.map(member.cursor.head),
            };
          }
        }
        if (tr.selectionSet || tr.docChanged) scheduleMemberSend();
        return value;
      },
    },
    view: () => ({
      update(view, prevState) {
        if (view.state.selection !== prevState.selection) scheduleMemberSend();
      },
    }),
  });

  const leaseAdsPlugin = new Plugin<DecorationSet>({
    key: leaseAdsKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, prev) {
        const next = tr.getMeta(leaseAdsKey) as DecorationSet | undefined;
        if (next) return next;
        return prev.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return leaseAdsKey.getState(state);
      },
    },
  });

  function memberPlugins(): Plugin[] {
    if (!cursorsEnabled()) return [memberPresencePlugin, leaseAdsPlugin];
    return [
      memberPresencePlugin,
      LoroEphemeralCursorPlugin(store, {
        user,
        createSelection: (peer) => ({
          class: 'loro-selection',
          style: `background-color: ${peerColor(peer).replace(')', ', 0.22)').replace('hsl', 'hsla')}`,
        }),
      }),
      leaseAdsPlugin,
    ];
  }

  return {
    plugins: memberPlugins,
    visiblePeers(): string[] {
      purgeStaleMembers();
      return [...remoteMembers.keys()];
    },
    presence(): { peer: string; name: string; color: string; self: boolean }[] {
      purgeStaleMembers();
      return [
        { peer: String(peerId), name: user.name, color: user.color, self: true },
        ...[...remoteMembers.values()].map((member) => ({
          peer: member.peer,
          name: member.name,
          color: member.color,
          self: false,
        })),
      ];
    },
    jumpToPeer(peer: string): boolean {
      purgeStaleMembers();
      const member = remoteMembers.get(peer);
      const view = getView();
      if (!member?.cursor || !view || view.isDestroyed) return false;
      const cursor = normalizeCursor(member.cursor, view.state.doc.content.size);
      if (!cursor) return false;
      try {
        const selection =
          cursor.from !== cursor.to
            ? TextSelection.create(view.state.doc, cursor.from, cursor.to)
            : Selection.near(view.state.doc.resolve(cursor.head), 1);
        view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
        view.focus();
        return true;
      } catch {
        return false;
      }
    },
    applyRemote(bytes: Uint8Array): boolean {
      if (disposed || bytes.length < 2) return false;
      const type = bytes[0];
      const payload = bytes.subarray(1);
      if (type === FRAME_CURSOR) {
        try {
          store.apply(payload);
        } catch {
          /* malformed or foreign frame */
        }
        return false;
      }
      if (type === FRAME_LEASE) {
        try {
          applyLeaseAd(JSON.parse(new TextDecoder().decode(payload)) as LeaseAd);
        } catch {
          /* malformed lease */
        }
        return false;
      }
      if (type === FRAME_MEMBER) {
        try {
          return applyMemberAd(JSON.parse(new TextDecoder().decode(payload)) as MemberAd);
        } catch {
          return false;
        }
      }
      return false;
    },
    dispose(): void {
      sendMemberNow(true);
      disposed = true;
      unsubLocal();
      clearInterval(cursorKeepalive);
      clearInterval(memberHeartbeat);
      clearInterval(leaseTimer);
      if (cursorSendTimer) clearTimeout(cursorSendTimer);
      if (memberSendTimer) clearTimeout(memberSendTimer);
    },
  };
}

function cursorsEnabled(): boolean {
  return settings.get('collabShowCursors');
}
