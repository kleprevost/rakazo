import { Trans, useLingui } from "@lingui/react/macro";
import type { AssignmentWork, WorkPhase } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  answerableAskMessageIds,
  chatUserBubbleColors,
  dismissableAskMessageIds,
  foldPeerReplies,
  isRunWorking,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import {
  Button,
  buttonVariants,
  Disclosure,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, MoreHorizontal } from "lucide-react";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { authClient } from "../lib/auth";
import {
  getComposerEnterToSend,
  subscribeComposerEnterToSend,
} from "../lib/composer-enter-to-send-pref";
import { createPageSession } from "../lib/pages";
import { useSpaceQueries } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { activeThreadRuns } from "../lib/thread-events";
import { errorText } from "../lib/user-error";
import { runPhase, useWorkPhaseLabels } from "../lib/work-phase";
import { useAssignmentThread } from "./assignment/use-assignment-thread";
import { FALLBACK_BOT_COLOR } from "./shell/chat-shared";
import { Composer } from "./shell/composer";
import { Transcript } from "./shell/transcript";
import { useComposerActions } from "./shell/use-composer-actions";
import { WindowChrome } from "./WindowChrome";

/** One job given to one employee: its own conversation, runs and files. */
export function AssignmentPage() {
  const { assignmentId = "" } = useParams();
  return <AssignmentView key={assignmentId} assignmentId={assignmentId} />;
}

/**
 * Two jobs of one employee share its computer: while another job holds it, this one's newest
 * run waits in the queue, which reads as Queued instead of Running.
 */
function useAssignmentPhaseLabel(work: AssignmentWork | undefined): string {
  const { t } = useLingui();
  const phases = useWorkPhaseLabels();
  if (!work) return "";
  return work.phase === "running" && work.runs[0]?.status === "queued"
    ? t`Queued`
    : phases[work.phase];
}

function AssignmentView({ assignmentId }: { assignmentId: string }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const queries = useSpaceQueries();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const phases = useWorkPhaseLabels();
  const work = useQuery(queries.assignments.get.queryOptions({ input: { assignmentId } }));
  const assignment = work.data;
  const phaseLabel = useAssignmentPhaseLabel(assignment);
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState("");
  const bots = useQuery(queries.bots.list.queryOptions()).data;
  const bot = bots?.find((candidate) => candidate.id === assignment?.botId);
  const enterToSend = useSyncExternalStore(
    subscribeComposerEnterToSend,
    getComposerEnterToSend,
    () => false,
  );
  const thread = useAssignmentThread(assignmentId);
  const { snapshot } = thread;
  const [pageSession] = useState(createPageSession);
  const botId = assignment?.botId;

  // The shared chat actions, addressed to this assignment's thread.
  const refreshRef = useMemo(() => ({ current: () => thread.refresh() }), [thread.refresh]);
  const noGroup = useMemo(() => ({ current: undefined }), []);
  const activeBotId = useMemo(() => ({ current: botId }), [botId]);
  const botsRef = useMemo(() => ({ current: bots ?? [] }), [bots]);
  const noComputer = useMemo(() => ({ current: null }), []);
  const refreshGroupRef = useMemo(() => ({ current: () => thread.refresh() }), [thread.refresh]);
  const composer = useComposerActions({
    rpc,
    pageSession,
    activeId: botId,
    assignmentId,
    inGroup: false,
    groupId: undefined,
    activeBotId,
    activeGroupId: noGroup,
    botsRef,
    bootstrapMe: undefined,
    activeSnapshot: snapshot,
    navigate,
    refreshBots: async () => {},
    refreshThreadRef: refreshRef,
    refreshGroupThreadRef: refreshGroupRef,
    updateSnapshot: thread.updateSnapshot,
    terminalRunReceipts: thread.terminalRunReceipts,
    computerRef: noComputer,
    commitComputer: () => {},
    clearReadBoundary: () => {},
    flushPendingBrowserNotifications: () => {},
  });

  const runs = activeThreadRuns(snapshot);
  const workingRuns = runs.filter((run) => isRunWorking(run.status));
  // A ticket's run keeps trigger "tickets", which a chat snapshot leaves out while it works, so
  // the assignment's own run list says whether anything is still going.
  const isLive = (status: string) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
  const live =
    runs.some((run) => isLive(run.status)) ||
    (assignment?.runs ?? []).some((run) => isLive(run.status));
  const working =
    workingRuns.length > 0 || (assignment?.runs ?? []).some((run) => isRunWorking(run.status));
  const transcript = useMemo(
    () => foldPeerReplies(snapshot?.messages ?? [], { includePeerReceipts: true }),
    [snapshot?.messages],
  );
  const answerableAskIds = useMemo(() => answerableAskMessageIds(snapshot), [snapshot]);
  const dismissableAskIds = useMemo(
    () => dismissableAskMessageIds(snapshot, userId),
    [snapshot, userId],
  );
  const act = async (action: () => Promise<unknown>) => {
    setActionError("");
    try {
      await action();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queries.assignments.get.key() }),
        queryClient.invalidateQueries({ queryKey: queries.assignments.list.key() }),
        thread.refresh(),
      ]);
    } catch (cause) {
      setActionError(errorText(cause, t`Could not complete action`));
    }
  };
  const artifactTarget = useMemo(() => ({ botId: botId ?? "" }), [botId]);
  const workingBots: GroupAvatarMember[] = workingRuns.map((run) => ({
    botId: run.botId,
    color: bot?.color ?? FALLBACK_BOT_COLOR,
    avatarSet: bot?.avatarSet,
    name: bot?.name,
    status: run.status,
  }));
  const peerBot = useCallback(
    (id: string) => bots?.find((candidate) => candidate.id === id),
    [bots],
  );
  const openBot = useCallback((id: string) => navigate(`/app/${id}`), [navigate]);
  const markUnread = useCallback(
    (message: { id: string }) =>
      void rpc.threads.markUnread({ assignmentId, messageId: message.id }).catch(() => undefined),
    [assignmentId],
  );
  const reply = useCallback(
    (message: Parameters<typeof composer.setReplyTarget>[0]) => {
      composer.setReplyTarget(message);
      composer.setReplyQuote(null);
    },
    [composer.setReplyQuote, composer.setReplyTarget],
  );
  const quote = useCallback(
    (message: Parameters<typeof composer.setReplyTarget>[0], text: string) => {
      composer.setReplyTarget(message);
      composer.setReplyQuote(text);
    },
    [composer.setReplyQuote, composer.setReplyTarget],
  );
  const noopAddRoutine = useCallback(() => {}, []);
  const goToBot = useCallback(() => {
    if (botId) navigate(`/app/${botId}`);
  }, [botId, navigate]);

  const loadFailure = work.error ?? (assignment ? null : thread.loadError);
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to={botId ? `/app/${botId}` : "/app"}
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-medium">{assignment?.title}</h1>
        {assignment ? (
          <AssignmentStatus
            work={assignment}
            label={assignment.archivedAt && !live ? t`Archived` : phaseLabel}
            phases={phases}
          />
        ) : null}
        {assignment ? (
          <AssignmentMenu
            archived={assignment.archivedAt !== null}
            live={live}
            onCancel={() => act(() => rpc.assignments.cancel({ assignmentId }))}
            onArchive={() => act(() => rpc.assignments.archive({ assignmentId }))}
            onRestore={() => act(() => rpc.assignments.unarchive({ assignmentId }))}
          />
        ) : null}
      </header>
      {actionError ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {loadFailure ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          {errorText(loadFailure)}
        </p>
      ) : !assignment || !snapshot ? (
        <PageLoading />
      ) : (
        <>
          <Transcript
            scrollRef={thread.scrollRef}
            scrollRequest={null}
            onScrollRequestHandled={noopAddRoutine}
            followRequest={composer.sentCount}
            artifactTarget={artifactTarget}
            transcript={transcript}
            showToolActivity
            olderCursor={snapshot.olderCursor ?? null}
            unreadAfterSeq={null}
            loadingOlder={thread.loadingOlder}
            answerableAskIds={answerableAskIds}
            dismissableAskIds={dismissableAskIds}
            running={working}
            workingBots={workingBots}
            userBubble={bot ? chatUserBubbleColors(bot.color, bot.id) : undefined}
            onLoadOlder={thread.loadOlder}
            onOpenBot={openBot}
            onAnswer={composer.answerMessage}
            onReply={reply}
            onMarkUnread={markUnread}
            onQuote={quote}
            onReact={composer.reactToMessage}
            onJumpToMessage={noopAddRoutine}
            onOpenPeerMessages={noopAddRoutine}
            peerBot={peerBot}
            onRefresh={async () => void (await thread.refresh())}
            onBotChanged={async () => {}}
            onAddRoutine={noopAddRoutine}
            voiceReady={false}
            speakingMessageId={null}
            onSpeak={noopAddRoutine}
            onOpenComputer={goToBot}
            rpc={rpc}
          />
          <Composer
            draftKey={`assignment:${assignmentId}`}
            enterToSend={enterToSend}
            activeName={bot?.name}
            running={live}
            pendingAttachments={composer.activePendingAttachments}
            attachmentNotice={composer.attachmentNotice}
            sendError={composer.sendError}
            imageConfirmation={composer.imageConfirmation}
            onDraftEdited={composer.clearImageConfirmation}
            onOpenModels={goToBot}
            onOpenConnections={goToBot}
            runError={composer.displayedRunError}
            runErrorId={composer.displayedRunErrorId}
            onRunErrorPresented={composer.handleRunErrorPresented}
            onDismissError={composer.dismissComposerError}
            sending={composer.sending}
            fileInputRef={composer.fileInputRef}
            onAttachmentPick={composer.onAttachmentPick}
            onRemoveAttachment={composer.removeAttachment}
            onSend={composer.sendMessage}
            onStop={composer.stopRun}
            artifactTarget={artifactTarget}
            replyTarget={composer.replyTarget}
            replyQuote={composer.replyQuote}
            onClearReply={composer.clearReply}
          />
        </>
      )}
    </div>
  );
}

/** The phase, opening to the runs and files this job produced once there are any. */
function AssignmentStatus({
  work,
  label,
  phases,
}: {
  work: AssignmentWork;
  label: string;
  phases: Record<WorkPhase, string>;
}) {
  if (work.runs.length === 0 && work.artifacts.length === 0) {
    return <span className="shrink-0 text-sm text-muted-foreground">{label}</span>;
  }
  return (
    <Disclosure
      data-testid="assignment-status"
      className="relative shrink-0"
      summaryClassName="text-sm text-muted-foreground"
      contentClassName="absolute end-0 top-full z-10 mt-2 w-72 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
      summary={label}
    >
      <ul className="space-y-1 text-xs text-muted-foreground">
        {work.runs.map((run) => (
          <li key={run.id} className="flex justify-between gap-3">
            <span>{phases[runPhase(run.status)]}</span>
            <time dateTime={run.createdAt}>{formatRelativeTime(run.createdAt)}</time>
          </li>
        ))}
      </ul>
      {work.artifacts.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2">
          {work.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <Link
                to={`/app/artifacts/${artifact.id}`}
                className="inline-block max-w-56 truncate rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
              >
                {artifact.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Disclosure>
  );
}

/** Cancel stops the job's live runs; Archive hides a finished one; Restore brings it back. */
function AssignmentMenu({
  archived,
  live,
  onCancel,
  onArchive,
  onRestore,
}: {
  archived: boolean;
  live: boolean;
  onCancel: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t`More`} render={<Button variant="ghost" size="icon" />}>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {live ? (
          <DropdownMenuItem onClick={onCancel}>
            <Trans>Cancel</Trans>
          </DropdownMenuItem>
        ) : null}
        {!live && !archived ? (
          <DropdownMenuItem onClick={onArchive}>
            <Trans>Archive</Trans>
          </DropdownMenuItem>
        ) : null}
        {archived ? (
          <DropdownMenuItem onClick={onRestore}>
            <Trans>Restore</Trans>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
