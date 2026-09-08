// ═══════════════════════════════════════════════════════════════════════════
// 默认 Renderer（§5.7 §10.3）：M4「消息是数据，不是指令」的落点。
//
// 四条防线（§10.3）：
//  1 渲染层强制包裹 —— 一切外来内容必须在 <<<MSG>>>…<<<END MSG>>> 内，
//    正文 <<< / >>> 转义为 \x3c\x3c\x3c / \x3e\x3e\x3e，转义在输出后再校验
//  2 from 不可伪造 —— id/seq/from/conv 全部由信封系统层填写
//  3 工具描述显式声明（tools.ts 的固定文案）
//  4 不把消息体拼进 system prompt —— 宿主责任（README 集成契约）
//
// sink / external 走另一条渲染路径：结构化 JSON（§5.7）——它们背后没有
// LLM，包裹的职责转移到宿主的 UI / 适配层。
// ═══════════════════════════════════════════════════════════════════════════

import type {
  Envelope,
  InboxState,
  InboxView,
  RecentPreview,
  Renderer
} from "./types.js";
import { truncate } from "./util.js";

export const MSG_OPEN = "<<<MSG";
export const MSG_CLOSE = "<<<END MSG>>>";
export const INBOX_OPEN = "<<<INBOX";
export const INBOX_CLOSE = "<<<END INBOX>>>";
export const CATCHUP_OPEN = "<<<CATCHUP";
export const CATCHUP_CLOSE = "<<<END CATCHUP>>>";

/** 定界符转义（防线 1）：正文里的 <<< / >>> 不得逃出包裹体 */
export function escapeDelims(s: string): string {
  return s.replaceAll("<<<", "\\x3c\\x3c\\x3c").replaceAll(">>>", "\\x3e\\x3e\\x3e");
}

function attrs(parts: Array<[string, string | number | undefined]>): string {
  return parts
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}="${String(v).replaceAll('"', "'")}"`)
    .join(" ");
}

export function renderAttachmentRefs(env: Envelope): string {
  const atts = env.payload.attachments ?? [];
  if (atts.length === 0) return "";
  return (
    "\n" +
    atts
      .map(
        (a) =>
          `[attachment ${a.spaceId}/${a.key}${a.version === undefined ? "" : ` v${a.version}`} — read it with mesh_shared_get]`
      )
      .join("\n")
  );
}

/** 包裹校验（防线 1 的运行时侧；devMode 抛错，生产强制加壳，§23.7） */
export function verifyWrapped(text: string): { ok: boolean; fixed: string } {
  const opens = (text.match(/<<<MSG[ >]/g) ?? []).length;
  const closes = text.split(MSG_CLOSE).length - 1;
  if (opens === 1 && closes === 1 && text.trimEnd().endsWith(MSG_CLOSE)) {
    // 检查包裹体内是否残留未转义定界符（开标记之后、END 之前）
    const bodyStart = text.indexOf(">>>\n") >= 0 ? text.indexOf(">>>\n") + 4 : 0;
    const bodyEnd = text.lastIndexOf(MSG_CLOSE);
    const body = text.slice(bodyStart, bodyEnd);
    if (!body.includes("<<<") && !body.includes(">>>")) return { ok: true, fixed: text };
  }
  // 强制加壳（生产降级路径）：整体转义后重新包裹
  return { ok: false, fixed: `${MSG_OPEN} kind="escaped">>>\n${escapeDelims(text)}\n${MSG_CLOSE}` };
}

export class DefaultRenderer implements Renderer {
  renderMessage(env: Envelope, ctx: { recipient: { endpointClass: string }; senderName: string }): string {
    // sink / external：结构化 JSON，不套文本壳（§5.7）
    if (ctx.recipient.endpointClass !== "stream") {
      return JSON.stringify(
        {
          envelope: {
            id: env.id,
            seq: env.seq,
            conversationId: env.conversationId,
            from: env.from,
            kind: env.kind,
            expect: env.expect,
            priority: env.priority,
            mentions: env.mentions,
            replyTo: env.replyTo,
            correlationId: env.correlationId,
            routedAt: env.routedAt
          },
          payload: env.payload,
          ext: env.ext
        },
        null,
        2
      );
    }
    const header = attrs([
      ["id", env.id],
      ["seq", env.seq],
      ["conv", env.conversationId],
      ["from", env.from],
      ["name", ctx.senderName],
      ["kind", env.kind],
      ["mentions", env.mentions?.length ? env.mentions.join(",") : undefined],
      ["ts", env.logicalTs ?? env.routedAt],
      ["reply_to", env.replyTo],
      ["correlation", env.correlationId]
    ]);
    const body = escapeDelims(env.payload.text ?? "");
    return `${MSG_OPEN} ${header}>>>\n${body}${renderAttachmentRefs(env)}\n${MSG_CLOSE}`;
  }

  renderSystem(env: Envelope): string {
    const header = attrs([
      ["id", env.id],
      ["seq", env.seq],
      ["conv", env.conversationId],
      ["from", env.from],
      ["kind", "system"]
    ]);
    return `${MSG_OPEN} ${header}>>>\n${escapeDelims(env.payload.text ?? "")}\n${MSG_CLOSE}`;
  }

  /** P2 注入体（§7.6）：每次 LLM 调用前重算，不落盘 */
  renderInbox(view: InboxView, recent: Envelope[]): string {
    const blocks: string[] = [];
    for (const conv of view.conversations) {
      if (conv.unread <= 0 && !conv.overflow) continue;
      const head = attrs([
        ["conv", conv.conversationId],
        ["unread", conv.unread],
        ["overflow", conv.overflow ?? 0]
      ]);
      const lines: string[] = [];
      if (conv.summary) lines.push(`[summary] ${conv.summary}`);
      lines.push(`[digest] ${conv.unread} unread message(s) in this conversation.`);
      const recents = recent.filter((e) => e.conversationId === conv.conversationId).slice(-3);
      if (recents.length > 0) {
        lines.push("[recent]");
        for (const e of recents) {
          const h = attrs([
            ["id", e.id],
            ["seq", e.seq],
            ["from", e.from],
            ["kind", e.kind]
          ]);
          lines.push(`  ${MSG_OPEN} ${h}>>> ${escapeDelims(truncate(e.payload.text ?? "", 40))} ${MSG_CLOSE}`);
        }
      }
      blocks.push(`${INBOX_OPEN} ${head}>>>\n${lines.join("\n")}\n${INBOX_CLOSE}`);
    }
    if (blocks.length === 0) return "";
    return blocks.join("\n\n");
  }

  /** CATCHUP 固化体（§7.6 升回预算内时，一条 CustomMessageEntry 永久写进历史） */
  renderCatchup(convId: string, missed: number, spanFrom: number, spanTo: number, digest: string): string {
    const head = attrs([
      ["conv", convId],
      ["missed", missed],
      ["span", `seq ${spanFrom}\u2013${spanTo}`]
    ]);
    return `${CATCHUP_OPEN} ${head}>>>\nYou are catching up: ${missed} message(s) you missed while away.\n${escapeDelims(digest)}\n${CATCHUP_CLOSE}`;
  }
}

/** 机械摘要（§7.5：无 LLM——条数 + 参与者 + 每条截断 40 字） */
export function mechanicalDigest(items: Array<{ from: string; name: string; seq: number; text: string }>): string {
  const bySpeaker = new Map<string, number>();
  for (const it of items) bySpeaker.set(it.name, (bySpeaker.get(it.name) ?? 0) + 1);
  const top = [...bySpeaker.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n, c]) => `${n}(${c})`)
    .join(", ");
  const previews = items
    .slice(0, 10)
    .map((it) => `  seq ${it.seq} ${it.name}: ${truncate(it.text, 40)}`)
    .join("\n");
  return `most active speakers: ${top || "(none)"}\n${previews}`;
}

/** InboxState.recent 预览（§10.4：≤3 条、40 字、mentionsMe 布尔化） */
export function toRecentPreview(env: Envelope, me: string, nameOf: (id: string) => string): RecentPreview {
  return {
    seq: env.seq,
    from: env.from,
    name: nameOf(env.from),
    preview: truncate(env.payload.text ?? "", 40),
    mentionsMe: env.mentions?.includes(me) ?? false,
    expectsMyAck: env.expect !== "none" && (env.to?.includes(me) ?? true)
  };
}

export function inboxSummaryLine(conv: InboxState): string {
  return conv.summary ?? `${conv.unread} unread`;
}
