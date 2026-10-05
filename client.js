/**
 * Session Purge — Web client half.
 *
 * Zero-build module-loader artifact: one sidebar button (`sidebar.footer.action`)
 * plus one self-drawn dialog (`shell.overlay`). No Harness Client package is
 * imported — only `react` from the browser module table — and every colour comes
 * from a `--dsw-alias-*` theme token, so light/dark and future themes keep working.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-purge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;

    const NS = 'session-purge';
    const ENDPOINT = '/api-ext/session-purge';

    const zh = {
      'action.open': '彻底删除工作区',
      'action.title': '彻底删除工作区…',
      'dialog.title': '彻底删除工作区',
      'dialog.subtitle':
        '与列表里的「删除工作区」不同：那个只把工作区从列表移除、保留全部会话记录。这里会永久删除该工作区的会话记录、投影缓存、相关附件，以及项目文件夹本身。',
      'dialog.close': '关闭',
      'action.sweep': '回收无引用附件',
      'sweep.intro':
        '扫描全部剩余会话的日志，回收没有任何会话引用的附件。不会删除任何会话或工作区。下面先做一次只读预检。',
      'sweep.scanning': '正在扫描全部剩余会话…',
      'sweep.wouldRemove': '将回收 {objects} 个对象（{bytes}）',
      'sweep.wouldKeep': '保留 {objects} 个仍被引用的对象',
      'sweep.nothing': '没有需要回收的对象，一切都被引用着。',
      'sweep.blocked': '已放弃回收：{count} 个会话无法读取（{reasons}）。宁可留垃圾，也不误删。',
      'sweep.failed': '预检失败：{message}',
      'sweep.run': '开始回收',
      'sweep.running': '正在回收…',
      'sweep.done': '回收完成：{objects} 个对象（{bytes}）',
      'sweep.noStore': '找不到附件存储目录，无法回收。',
      'step.pick': '选择一个工作区',
      'step.preview': '确认删除范围',
      'step.done': '执行结果',
      'list.empty': '当前没有任何工作区。',
      'list.loadFailed': '读取工作区列表失败：{message}',
      'list.sessions': '{count} 个会话',
      'list.live': '{count} 个正在运行',
      'list.archived': '{count} 个已归档',
      'list.missingFolder': '文件夹不存在',
      'list.refresh': '刷新',
      'preview.cancel': '返回',
      'preview.confirm': '永久删除',
      'preview.working': '正在删除…',
      'preview.sessions': '会话记录',
      'preview.cache': '投影缓存',
      'preview.folder': '项目文件夹',
      'preview.total': '合计',
      'preview.willDeleteFolder': '将删除该项目文件夹（不可恢复）',
      'preview.keepFolder': '配置为只删 DSH 内容，项目文件夹保留',
      'preview.folderMissing': '项目文件夹已不存在，仅清理 DSH 内容',
      'preview.folderWritable': '可写',
      'preview.folderReadonly': '不可写（{reason}）',
      'preview.topEntries': '顶层条目',
      'preview.guardRefused': '已被安全护栏拒绝',
      'preview.unresolved': '{count} 个会话无法确定 cwd，将被跳过',
      'preview.attachments': '同时回收未被其它会话引用的附件',
      'preview.attachmentsHint':
        '需要先扫描全部剩余会话来建立引用集合；只要有任何一个会话读取失败，本次就跳过附件回收。',
      'preview.typedLabel': '请输入文件夹名「{name}」以解锁删除',
      'preview.typedPlaceholder': '文件夹名',
      'preview.liveWarning': '有 {count} 个会话正工作在这个目录里，删除会停止它们。',
      'preview.acknowledge': '我确认要停止这些会话',
      'preview.noUndo': '没有回收站，DSH 无法撤销。',
      'done.deleted': '已永久删除',
      'done.summary': '{sessions} 个会话 · {cache} 个投影缓存 · 项目文件夹{folder}',
      'done.folderYes': '已删除',
      'done.folderNo': '未删除',
      'done.steps': '执行明细',
      'done.failed': '失败 / 残留',
      'done.residuals': '仍有 {files} 个文件未能删除',
      'done.attachments': '附件：回收 {objects} 个对象（{bytes}）',
      'done.attachmentsSkipped': '附件回收已跳过：{reason}',
      'done.close': '完成',
      'step.ok': '成功',
      'step.partial': '部分成功',
      'step.skipped': '跳过',
      'step.failed': '失败',
      'step.dry-run': '预检',
      'step.guards': '安全护栏',
      'step.sessions': '会话删除',
      'step.registry': '工作区注册',
      'step.empty-project-dir': '空目录清理',
      'step.project-folder': '项目文件夹',
      'step.attachments': '附件回收',
      'error.current-session':
        '当前对话就工作在这个目录里。请先新建或切换到别的会话，再回来删除此工作区。',
      'error.live-sessions-unacknowledged': '有会话正在这个目录里，请先勾选确认。',
      'error.confirm-required': '请先预检再确认。',
      'error.network': '请求失败：{message}',
      'guard.invalid-target': '工作区路径无效。',
      'guard.symlink-target': '该路径是符号链接，已拒绝删除以免误伤链接背后的目录。',
      'guard.too-shallow': '路径层级过浅，已拒绝删除。',
      'guard.remote-volume': '目标是网络共享路径，无法可靠递归删除。',
      'guard.protected-path': '该目录包含受保护的 DSH 或系统位置。',
      'guard.current-session': '当前对话就在这个目录里，请先切换会话。',
      'guard.nested-workspace': '该目录里还注册着其它工作区，删除会毁掉那些项目。',
      'guard.nested-session': '该目录里有子目录被其它会话当作工作目录。',
    };

    const en = {
      'action.open': 'Purge workspace',
      'action.title': 'Purge workspace…',
      'dialog.title': 'Purge workspace',
      'dialog.subtitle':
        'Different from "Delete workspace" in the list: that one only removes the row and keeps every session log. This permanently deletes the sessions, the projection cache, related attachments and the project folder itself.',
      'dialog.close': 'Close',
      'action.sweep': 'Reclaim orphan attachments',
      'sweep.intro':
        'Reads every remaining session log and reclaims attachments no session references. No session or workspace is deleted. A read-only check runs first.',
      'sweep.scanning': 'Reading every remaining session…',
      'sweep.wouldRemove': 'Would reclaim {objects} objects ({bytes})',
      'sweep.wouldKeep': 'Keeping {objects} objects that are still referenced',
      'sweep.nothing': 'Nothing to reclaim — everything is referenced.',
      'sweep.blocked': 'Reclaim skipped: {count} sessions could not be read ({reasons}). Keeping garbage beats deleting a live object.',
      'sweep.failed': 'Check failed: {message}',
      'sweep.run': 'Reclaim now',
      'sweep.running': 'Reclaiming…',
      'sweep.done': 'Reclaimed {objects} objects ({bytes})',
      'sweep.noStore': 'No attachment store found; nothing to reclaim.',
      'step.pick': 'Pick a workspace',
      'step.preview': 'Confirm the scope',
      'step.done': 'Result',
      'list.empty': 'No workspaces.',
      'list.loadFailed': 'Could not read the workspace list: {message}',
      'list.sessions': '{count} sessions',
      'list.live': '{count} running',
      'list.archived': '{count} archived',
      'list.missingFolder': 'Folder missing',
      'list.refresh': 'Refresh',
      'preview.cancel': 'Back',
      'preview.confirm': 'Delete permanently',
      'preview.working': 'Deleting…',
      'preview.sessions': 'Session logs',
      'preview.cache': 'Projection cache',
      'preview.folder': 'Project folder',
      'preview.total': 'Total',
      'preview.willDeleteFolder': 'The project folder will be deleted (irreversible)',
      'preview.keepFolder': 'Configured to keep the project folder',
      'preview.folderMissing': 'The folder is already gone; only DSH state is cleaned',
      'preview.folderWritable': 'writable',
      'preview.folderReadonly': 'not writable ({reason})',
      'preview.topEntries': 'Top-level entries',
      'preview.guardRefused': 'Refused by the safety guards',
      'preview.unresolved': '{count} sessions have no readable cwd and will be skipped',
      'preview.attachments': 'Also reclaim attachments no other session references',
      'preview.attachmentsHint':
        'Requires reading every remaining session to build the reference set; if any session fails to read, the sweep is skipped entirely.',
      'preview.typedLabel': 'Type the folder name "{name}" to unlock deletion',
      'preview.typedPlaceholder': 'folder name',
      'preview.liveWarning': '{count} sessions are working inside this folder; deleting stops them.',
      'preview.acknowledge': 'I understand those sessions will be stopped',
      'preview.noUndo': 'There is no recycle bin and DSH cannot undo this.',
      'done.deleted': 'Permanently deleted',
      'done.summary': '{sessions} sessions · {cache} cache files · project folder {folder}',
      'done.folderYes': 'deleted',
      'done.folderNo': 'kept',
      'done.steps': 'Steps',
      'done.failed': 'Failures / leftovers',
      'done.residuals': '{files} files could not be removed',
      'done.attachments': 'Attachments: reclaimed {objects} objects ({bytes})',
      'done.attachmentsSkipped': 'Attachment sweep skipped: {reason}',
      'done.close': 'Done',
      'step.ok': 'ok',
      'step.partial': 'partial',
      'step.skipped': 'skipped',
      'step.failed': 'failed',
      'step.dry-run': 'dry run',
      'step.guards': 'Safety guards',
      'step.sessions': 'Sessions',
      'step.registry': 'Workspace row',
      'step.empty-project-dir': 'Empty dirs',
      'step.project-folder': 'Project folder',
      'step.attachments': 'Attachments',
      'error.current-session':
        'The current conversation works inside this folder. Create or switch to another session first.',
      'error.live-sessions-unacknowledged': 'Sessions are working in this folder; acknowledge first.',
      'error.confirm-required': 'Preview first, then confirm.',
      'error.network': 'Request failed: {message}',
      'guard.invalid-target': 'The workspace path is invalid.',
      'guard.symlink-target': 'The path is a symlink; refusing to delete its target.',
      'guard.too-shallow': 'The path is too close to the filesystem root.',
      'guard.remote-volume': 'The target is a network share; recursive deletion is unreliable.',
      'guard.protected-path': 'The folder contains a protected DSH or system location.',
      'guard.current-session': 'The current conversation lives in this folder; switch sessions first.',
      'guard.nested-workspace': 'Other workspaces are registered inside this folder.',
      'guard.nested-session': 'Sessions use subdirectories of this folder as their cwd.',
    };

    const CSS = `
.dsp-footer{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 10px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer;min-width:0;font-family:inherit}
.dsp-footer:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsp-footer:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dsp-footerLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsp-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}
.dsp-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.dsp-dialog{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;width:min(620px,100%);max-height:100%;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsp-dialog:focus{outline:none}
.dsp-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:20px 14px 8px 24px;flex:none}
.dsp-title{margin:0;font-size:16px;line-height:24px;font-weight:500}
.dsp-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1}
.dsp-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsp-subtitle{margin:0;padding:0 24px 4px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;flex:none}
.dsp-body{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 24px 4px}
.dsp-footerBar{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:16px 24px 20px;flex:none}
.dsp-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;cursor:pointer;font-family:inherit;min-width:72px}
.dsp-button:disabled{cursor:not-allowed;opacity:.4}
.dsp-button.outline{border:.5px solid var(--dsw-alias-border-l3)}
.dsp-button.outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsp-button.danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.dsp-button.danger:hover:not(:disabled){opacity:.9}
.dsp-row{display:flex;align-items:flex-start;gap:8px;width:100%;box-sizing:border-box;text-align:left;padding:8px 10px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;cursor:pointer;font-family:inherit;font-size:14px}
.dsp-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsp-rowMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsp-rowTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsp-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsp-badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}
.dsp-badge{padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.dsp-badge.warn{color:var(--dsw-alias-state-warn-primary)}
.dsp-badge.error{color:var(--dsw-alias-state-error-primary)}
.dsp-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsp-table{display:flex;flex-direction:column;gap:4px;margin:8px 0 4px}
.dsp-tr{display:flex;align-items:baseline;gap:10px;justify-content:space-between}
.dsp-td{color:var(--dsw-alias-label-secondary)}
.dsp-td.value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsp-divider{height:1px;background:var(--dsw-alias-border-l3);opacity:.6;margin:10px 0}
.dsp-note{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsp-note.error{color:var(--dsw-alias-state-error-primary)}
.dsp-note.warn{color:var(--dsw-alias-state-warn-primary)}
.dsp-field{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.dsp-field label{font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsp-input{box-sizing:border-box;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit}
.dsp-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsp-check{display:flex;align-items:flex-start;gap:8px;margin-top:10px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsp-check input{flex:none;width:16px;height:16px;margin:3px 0 0;accent-color:var(--dsw-alias-button-primary-fill);cursor:pointer}
.dsp-steps{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.dsp-step{display:flex;align-items:baseline;gap:8px;font-size:13px}
.dsp-step .name{color:var(--dsw-alias-label-secondary);min-width:112px}
.dsp-step .status{font-variant-numeric:tabular-nums}
.dsp-step .detail{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsp-scroll{max-height:180px;overflow:auto}
`;

    /** Tiny external store shared by the button and the dialog. */
    function createStore() {
      let state = { open: false };
      const listeners = new Set();
      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        setOpen: (open) => {
          if (state.open === open) return;
          state = { open };
          for (const listener of listeners) listener();
        },
      };
    }

    /** Format bytes for humans. */
    function formatBytes(value) {
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let index = 0;
      let size = value;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
    }

    /** Best-effort read of the session this page is showing (for the server check). */
    function readSessionId() {
      try {
        const raw = window.localStorage.getItem('dsh.sessions.current');
        if (!raw) return undefined;
        const match = /session-[A-Za-z0-9-]{1,64}/.exec(raw);
        return match ? match[0] : undefined;
      } catch {
        return undefined;
      }
    }

    /** Call one of the plugin's own routes. */
    async function call(path, body) {
      const init =
        body === undefined
          ? { method: 'GET' }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            };
      let response;
      try {
        response = await fetch(`${ENDPOINT}${path}`, init);
      } catch (error) {
        throw Object.assign(new Error(String(error?.message ?? error)), { code: 'network' });
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'network' });
      }
      if (!payload || payload.ok !== true) {
        const error = payload?.error ?? {};
        throw Object.assign(new Error(error.message ?? `HTTP ${response.status}`), {
          code: error.code ?? 'network',
          details: error.details,
        });
      }
      return payload.value;
    }

    function FolderIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
        h('path', {
          d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2c.4 0 .78.16 1.06.44L8 4.5h4.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M6.2 8.4h3.6M8 6.6v3.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      );
    }

    /** Localised guard message, falling back to the server's own text. */
    function guardText(t, code, fallback) {
      if (!code) return fallback ?? '';
      const key = `guard.${code}`;
      const text = t(key, {});
      return text === key ? (fallback ?? code) : text;
    }

    /** Component-local stylesheet element (removed with the component). */
    function Styles() {
      return h('style', { 'data-dsh-session-purge': '', dangerouslySetInnerHTML: { __html: CSS } });
    }

    /** The sidebar footer button. */
    function PurgeButton(props) {
      const { t, wide, store } = props;
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
      const label = t('action.open');
      return h(
        React.Fragment,
        null,
        h(Styles, { key: 'styles' }),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'dsp-footer',
            title: label,
            'aria-label': label,
            'aria-expanded': snapshot.open ? 'true' : 'false',
            onClick: () => store.setOpen(true),
          },
          h(FolderIcon),
          wide ? h('span', { className: 'dsp-footerLabel' }, label) : null,
        ),
      );
    }

    /** The confirmation dialog, rendered into `shell.overlay`. */
    function PurgeDialog(props) {
      const { t, store } = props;
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
      const [phase, setPhase] = useState('list');
      const [listing, setListing] = useState(null);
      const [selected, setSelected] = useState(null);
      const [preview, setPreview] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [typed, setTyped] = useState('');
      const [withAttachments, setWithAttachments] = useState(true);
      const [acknowledge, setAcknowledge] = useState(false);
      const [result, setResult] = useState(null);
      const [sweepState, setSweepState] = useState(null);
      const dialogRef = useRef(null);

      const close = useCallback(() => store.setOpen(false), [store]);

      const loadList = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const value = await call('/list');
          setListing(value);
        } catch (caught) {
          setError(t('error.network', { message: caught.message }));
        } finally {
          setBusy(false);
        }
      }, [t]);

      const openPreview = useCallback(
        async (workspace) => {
          setBusy(true);
          setError(null);
          setSelected(workspace);
          setResult(null);
          setTyped('');
          setAcknowledge(false);
          try {
            const value = await call('/preview', {
              workspaceId: workspace.id,
              sessionId: readSessionId(),
            });
            setPreview(value);
            setWithAttachments(listing?.config?.deleteAttachments !== false);
            setPhase('preview');
          } catch (caught) {
            setError(guardText(t, caught.code, caught.message));
          } finally {
            setBusy(false);
          }
        },
        [listing, t],
      );

      const run = useCallback(async () => {
        if (!selected) return;
        setBusy(true);
        setError(null);
        try {
          const value = await call('/execute', {
            workspaceId: selected.id,
            sessionId: readSessionId(),
            attachments: withAttachments,
            folderName: typed,
            acknowledgeLive: acknowledge,
            confirm: true,
          });
          setResult(value);
          setPhase('done');
        } catch (caught) {
          const key = `error.${caught.code}`;
          const localised = t(key, {});
          setError(localised === key ? caught.message : localised);
          if (caught.code === 'live-sessions-unacknowledged') setAcknowledge(false);
        } finally {
          setBusy(false);
        }
      }, [acknowledge, selected, t, typed, withAttachments]);

      // Standalone attachment reclamation: a read-only check, then an explicit
      // second click to actually remove. No workspace is involved.
      const checkSweep = useCallback(async () => {
        setSweepState({ phase: 'checking' });
        try {
          const value = await call('/sweep-attachments', { dryRun: true });
          setSweepState({ phase: 'ready', value });
        } catch (caught) {
          setSweepState({ phase: 'error', message: caught.message });
        }
      }, []);

      const runSweep = useCallback(async () => {
        setSweepState((current) => ({ ...(current ?? {}), phase: 'running' }));
        try {
          const value = await call('/sweep-attachments', { confirm: true });
          setSweepState({ phase: 'done', value });
        } catch (caught) {
          setSweepState({ phase: 'error', message: caught.message });
        }
      }, []);

      // Reset and (re)load the list whenever the dialog opens.
      useEffect(() => {
        if (!snapshot.open) return;
        setPhase('list');
        setPreview(null);
        setSelected(null);
        setResult(null);
        setSweepState(null);
        setError(null);
        void loadList();
      }, [snapshot.open, loadList]);

      // Entering the sweep step runs its read-only check.
      useEffect(() => {
        if (!snapshot.open || phase !== 'sweep' || sweepState !== null) return;
        void checkSweep();
      }, [checkSweep, phase, snapshot.open, sweepState]);

      // Escape closes; focus lands inside the dialog.
      useEffect(() => {
        if (!snapshot.open) return;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
        };
        window.addEventListener('keydown', onKey, true);
        const timer = window.setTimeout(() => dialogRef.current?.focus(), 0);
        return () => {
          window.removeEventListener('keydown', onKey, true);
          window.clearTimeout(timer);
        };
      }, [snapshot.open, close]);

      if (!snapshot.open) return null;

      const plan = preview?.plan;
      const guardsOk = plan?.guards?.ok === true;
      const requiresName = listing?.config?.requireFolderNameConfirm !== false;
      const folderName = preview?.folderName ?? '';
      const wantsFolder = listing?.config?.deleteProjectFolder !== false && plan?.folderExists;
      const canDelete =
        guardsOk &&
        !busy &&
        (!requiresName || !wantsFolder || typed.trim().toLowerCase() === folderName.toLowerCase()) &&
        (acknowledge || (preview?.liveInside?.length ?? 0) === 0 || preview?.requester?.verified === true);

      let body;
      if (phase === 'list') {
        const rows = listing?.workspaces ?? [];
        body = h(
          'div',
          null,
          rows.length === 0
            ? h('p', { className: 'dsp-note' }, busy ? '…' : t('list.empty'))
            : h(
                'div',
                { className: 'dsp-table' },
                rows.map((workspace) =>
                  h(
                    'button',
                    {
                      key: workspace.id,
                      type: 'button',
                      className: 'dsp-row',
                      onClick: () => void openPreview(workspace),
                      disabled: busy,
                    },
                    h(FolderIcon),
                    h(
                      'span',
                      { className: 'dsp-rowMain' },
                      h('span', { className: 'dsp-rowTitle' }, workspace.title || workspace.id),
                      h('span', { className: 'dsp-path' }, workspace.path),
                      h(
                        'span',
                        { className: 'dsp-badges' },
                        h('span', { className: 'dsp-badge' }, t('list.sessions', { count: workspace.sessionCount })),
                        workspace.archivedCount > 0
                          ? h('span', { className: 'dsp-badge' }, t('list.archived', { count: workspace.archivedCount }))
                          : null,
                        workspace.liveCount > 0
                          ? h('span', { className: 'dsp-badge warn' }, t('list.live', { count: workspace.liveCount }))
                          : null,
                        workspace.folderExists
                          ? null
                          : h('span', { className: 'dsp-badge error' }, t('list.missingFolder')),
                      ),
                    ),
                  ),
                ),
              ),
        );
      } else if (phase === 'preview' && plan) {
        const files = plan.folderStats?.fileCount ?? 0;
        const folderBytes = plan.folderStats?.bytes ?? 0;
        const total = (plan.sessionsBytes ?? 0) + folderBytes;
        body = h(
          'div',
          null,
          h(
            'div',
            { className: 'dsp-table' },
            h(
              'div',
              { className: 'dsp-tr' },
              h('span', { className: 'dsp-td' }, t('preview.sessions')),
              h('span', { className: 'dsp-td value' }, `${plan.sessions.length} · ${formatBytes(plan.sessionsBytes)}`),
            ),
            h(
              'div',
              { className: 'dsp-tr' },
              h('span', { className: 'dsp-td' }, t('preview.cache')),
              h('span', { className: 'dsp-td value' }, String(plan.cacheFiles.length)),
            ),
            h(
              'div',
              { className: 'dsp-tr' },
              h('span', { className: 'dsp-td' }, t('preview.folder')),
              h(
                'span',
                { className: 'dsp-td value' },
                plan.folderExists ? `${files} · ${formatBytes(folderBytes)}` : '—',
              ),
            ),
            h('div', { className: 'dsp-divider' }),
            h(
              'div',
              { className: 'dsp-tr' },
              h('span', { className: 'dsp-td' }, t('preview.total')),
              h('span', { className: 'dsp-td value' }, formatBytes(total)),
            ),
          ),
          h('p', { className: 'dsp-path' }, plan.path),
          plan.folderStats?.topEntries?.length
            ? h(
                'p',
                { className: 'dsp-note' },
                `${t('preview.topEntries')}: ${plan.folderStats.topEntries.join('  ')}`,
              )
            : null,
          h(
            'p',
            { className: wantsFolder ? 'dsp-note error' : 'dsp-note' },
            !plan.folderExists
              ? t('preview.folderMissing')
              : wantsFolder
                ? t('preview.willDeleteFolder')
                : t('preview.keepFolder'),
          ),
          plan.folderWritable && plan.folderWritable.writable === false
            ? h(
                'p',
                { className: 'dsp-note warn' },
                t('preview.folderReadonly', { reason: plan.folderWritable.reason }),
              )
            : null,
          guardsOk
            ? null
            : h(
                'p',
                { className: 'dsp-note error' },
                `${t('preview.guardRefused')}：${guardText(t, plan.guards.code, plan.guards.message)}`,
                plan.guards.detail?.length ? h('span', { className: 'dsp-meta' }, ` (${plan.guards.detail.join('，')})`) : null,
              ),
          plan.unresolved?.length
            ? h('p', { className: 'dsp-note warn' }, t('preview.unresolved', { count: plan.unresolved.length }))
            : null,
          preview.liveInside?.length > 0 && preview.requester?.verified !== true
            ? h(
                'label',
                { className: 'dsp-check' },
                h('input', {
                  type: 'checkbox',
                  checked: acknowledge,
                  onChange: (event) => setAcknowledge(event.target.checked),
                }),
                h('span', null, `${t('preview.liveWarning', { count: preview.liveInside.length })} ${t('preview.acknowledge')}`),
              )
            : null,
          h(
            'label',
            { className: 'dsp-check' },
            h('input', {
              type: 'checkbox',
              checked: withAttachments,
              onChange: (event) => setWithAttachments(event.target.checked),
            }),
            h('span', null, t('preview.attachments')),
          ),
          h('p', { className: 'dsp-note' }, t('preview.attachmentsHint')),
          requiresName && wantsFolder
            ? h(
                'div',
                { className: 'dsp-field' },
                h('label', { htmlFor: 'dsp-typed' }, t('preview.typedLabel', { name: folderName })),
                h('input', {
                  id: 'dsp-typed',
                  className: 'dsp-input',
                  value: typed,
                  placeholder: t('preview.typedPlaceholder'),
                  autoComplete: 'off',
                  spellCheck: false,
                  onChange: (event) => setTyped(event.target.value),
                }),
              )
            : null,
          h('p', { className: 'dsp-note error' }, t('preview.noUndo')),
        );
      } else if (phase === 'done' && result) {
        const outcome = result.result;
        const steps = outcome.steps ?? [];
        body = h(
          'div',
          null,
          h(
            'div',
            { className: 'dsp-table' },
            h(
              'div',
              { className: 'dsp-tr' },
              h('span', { className: 'dsp-td' }, t('done.deleted')),
              h('span', { className: 'dsp-td value' }, String(outcome.deletedSessions.length) + ' / ' + String(result.title ?? '')),
            ),
          ),
          h('p', { className: 'dsp-path' }, result.path),
          h(
            'p',
            { className: result.folderDeleted ? 'dsp-note' : 'dsp-note warn' },
            t('done.summary', {
              sessions: outcome.deletedSessions.length,
              cache: outcome.cacheFilesDeleted,
              folder: outcome.folderDeleted ? t('done.folderYes') : t('done.folderNo'),
            }),
          ),
          outcome.attachments
            ? h(
                'p',
                { className: outcome.attachments.ok ? 'dsp-note' : 'dsp-note warn' },
                outcome.attachments.ok
                  ? t('done.attachments', {
                      objects: outcome.attachments.removedObjects,
                      bytes: formatBytes(outcome.attachments.removedBytes),
                    })
                  : t('done.attachmentsSkipped', { reason: outcome.attachments.message ?? outcome.attachments.code }),
              )
            : null,
          h('p', { className: 'dsp-note' }, t('done.steps')),
          h(
            'div',
            { className: 'dsp-steps dsp-scroll' },
            steps.map((entry, index) =>
              h(
                'div',
                { className: 'dsp-step', key: `${entry.step}-${index}` },
                h('span', { className: 'name' }, t(`step.${entry.step}`, {}) === `step.${entry.step}` ? entry.step : t(`step.${entry.step}`, {})),
                h('span', { className: 'status' }, t(`step.${entry.status}`, {}) === `step.${entry.status}` ? entry.status : t(`step.${entry.status}`, {})),
                entry.detail ? h('span', { className: 'detail' }, String(entry.detail)) : null,
              ),
            ),
          ),
          (outcome.failed?.length ?? 0) > 0
            ? h(
                'div',
                null,
                h('p', { className: 'dsp-note error' }, t('done.failed')),
                h(
                  'div',
                  { className: 'dsp-steps dsp-scroll' },
                  outcome.failed.map((entry, index) =>
                    h(
                      'div',
                      { className: 'dsp-step', key: `${entry.id}-${index}` },
                      h('span', { className: 'detail' }, `${entry.id} — ${entry.code}: ${entry.message}`),
                    ),
                  ),
                ),
              )
            : null,
          outcome.residuals?.fileCount
            ? h('p', { className: 'dsp-note error' }, t('done.residuals', { files: outcome.residuals.fileCount }))
            : null,
        );
      } else if (phase === 'sweep') {
        const state = sweepState ?? { phase: 'checking' };
        const value = state.value ?? null;
        const blocked = value?.blocked?.length ?? 0;
        const reasons = value?.reasons
          ? Object.entries(value.reasons)
              .map(([key, count]) => `${count}× ${key}`)
              .join('；')
          : '';
        const objects = value?.removedObjects ?? 0;
        const bytes = formatBytes(value?.removedBytes ?? 0);
        body = h(
          'div',
          null,
          h('p', { className: 'dsp-note' }, t('sweep.intro')),
          state.phase === 'checking'
            ? h('p', { className: 'dsp-note' }, t('sweep.scanning'))
            : state.phase === 'running'
              ? h('p', { className: 'dsp-note' }, t('sweep.running'))
              : null,
          state.phase === 'error'
            ? h('p', { className: 'dsp-note error' }, t('sweep.failed', { message: state.message }))
            : null,
          value && state.phase !== 'checking' && state.phase !== 'running'
            ? h(
                'div',
                { className: 'dsp-table' },
                value.skipped
                  ? h(
                      'div',
                      { className: 'dsp-tr' },
                      h('span', { className: 'dsp-td error' }, t('sweep.blocked', { count: blocked, reasons })),
                    )
                  : h(
                      'div',
                      { className: 'dsp-tr' },
                      h(
                        'span',
                        { className: 'dsp-td' },
                        state.phase === 'done' ? t('sweep.done', { objects, bytes }) : t('sweep.wouldRemove', { objects, bytes }),
                      ),
                      h('span', { className: 'dsp-td value' }, t('sweep.wouldKeep', { objects: value.keptObjects ?? 0 })),
                    ),
                typeof value.scanned === 'number'
                  ? h('p', { className: 'dsp-meta' }, t('list.sessions', { count: value.scanned }))
                  : null,
                !value.skipped && objects === 0 && state.phase !== 'done'
                  ? h('p', { className: 'dsp-note' }, t('sweep.nothing'))
                  : null,
              )
            : null,
          h('p', { className: 'dsp-note' }, t('preview.attachmentsHint')),
        );
      } else {
        body = h('p', { className: 'dsp-note' }, busy ? '…' : '');
      }

      const sweepPhase = sweepState?.phase;
      const sweepCanRun =
        sweepPhase === 'ready' &&
        sweepState.value?.skipped !== true &&
        (sweepState.value?.removedObjects ?? 0) > 0;

      const footer =
        phase === 'list'
          ? [
              h(
                'button',
                {
                  key: 'sweep',
                  type: 'button',
                  className: 'dsp-button outline',
                  onClick: () => {
                    setSweepState(null);
                    setError(null);
                    setPhase('sweep');
                  },
                  disabled: busy,
                },
                t('action.sweep'),
              ),
              h(
                'button',
                { key: 'refresh', type: 'button', className: 'dsp-button outline', onClick: () => void loadList(), disabled: busy },
                t('list.refresh'),
              ),
              h('button', { key: 'close', type: 'button', className: 'dsp-button', onClick: close }, t('dialog.close')),
            ]
          : phase === 'preview'
            ? [
                h(
                  'button',
                  {
                    key: 'back',
                    type: 'button',
                    className: 'dsp-button outline',
                    onClick: () => {
                      setPhase('list');
                      setError(null);
                    },
                    disabled: busy,
                  },
                  t('preview.cancel'),
                ),
                h(
                  'button',
                  {
                    key: 'run',
                    type: 'button',
                    className: 'dsp-button danger',
                    onClick: () => void run(),
                    disabled: !canDelete,
                  },
                  busy ? t('preview.working') : t('preview.confirm'),
                ),
              ]
            : phase === 'sweep'
              ? [
                  h(
                    'button',
                    {
                      key: 'back',
                      type: 'button',
                      className: 'dsp-button outline',
                      onClick: () => {
                        setSweepState(null);
                        setPhase('list');
                      },
                      disabled: sweepPhase === 'running',
                    },
                    t('preview.cancel'),
                  ),
                  sweepPhase === 'done'
                    ? h(
                        'button',
                        {
                          key: 'done',
                          type: 'button',
                          className: 'dsp-button',
                          onClick: () => {
                            setSweepState(null);
                            setPhase('list');
                            void loadList();
                          },
                        },
                        t('done.close'),
                      )
                    : h(
                        'button',
                        {
                          key: 'sweep-run',
                          type: 'button',
                          className: 'dsp-button danger',
                          onClick: () => void runSweep(),
                          disabled: !sweepCanRun,
                        },
                        sweepPhase === 'running' ? t('sweep.running') : t('sweep.run'),
                      ),
                ]
              : [h('button', { key: 'done', type: 'button', className: 'dsp-button', onClick: close }, t('done.close'))];

      return h(
        React.Fragment,
        null,
        h(Styles, { key: 'styles' }),
        h(
          'div',
          { className: 'dsp-overlay', role: 'presentation', key: 'overlay' },
          h('div', {
            className: 'dsp-mask',
            onClick: () => (busy ? undefined : close()),
            'aria-hidden': true,
          }),
          h(
            'div',
            {
              className: 'dsp-dialog',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': t('dialog.title'),
              tabIndex: -1,
              ref: dialogRef,
            },
            h(
              'div',
              { className: 'dsp-header' },
              h('h2', { className: 'dsp-title' }, t('dialog.title')),
              h(
                'button',
                { type: 'button', className: 'dsp-close', onClick: close, 'aria-label': t('dialog.close'), disabled: busy },
                '✕',
              ),
            ),
            h('p', { className: 'dsp-subtitle' }, t('dialog.subtitle')),
            h(
              'div',
              { className: 'dsp-body' },
              busy && phase === 'list' && !listing ? h('p', { className: 'dsp-note' }, '…') : body,
              error ? h('p', { className: 'dsp-note error' }, error) : null,
            ),
            h('div', { className: 'dsp-footerBar' }, footer),
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const store = createStore();
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-purge: dictionaries');
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'session-purge',
              locale: NS,
              inject: () => ({ store }),
            },
            PurgeButton,
          ),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'session-purge-dialog',
              locale: NS,
              inject: () => ({ store }),
            },
            PurgeDialog,
          ),
        );
      },
    };
  },
});
