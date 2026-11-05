import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ModelOption {
  modelId: string;
  name: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thought?: string;
  tools?: Array<{ name?: string; args?: any; tool?: any }>;
  isStreaming?: boolean;
}

interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  currentModelId: string;
  messageCount: number;
}

export const AntigravityAcpView: React.FC<{ active?: boolean }> = ({ active = true }) => {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory) || '/home/jeremy/develop/oc-workspace';

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionsList, setSessionsList] = useState<SessionSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [currentModelId, setCurrentModelId] = useState<string>('');
  const [tierName, setTierName] = useState<string>('Google AI Pro');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [initializing, setInitializing] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const refreshSessionsList = async () => {
    try {
      const res = await fetch('/api/acp/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessionsList(data.sessions || []);
      }
    } catch (err) {
      console.error('Failed to load ACP sessions:', err);
    }
  };

  // Initialize ACP session on mount
  useEffect(() => {
    let mounted = true;

    async function initSession() {
      try {
        setInitializing(true);
        setError(null);
        await refreshSessionsList();

        const res = await fetch('/api/acp/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: 'antigravity', cwd: currentDirectory }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (mounted) {
          setSessionId(data.sessionId);
          setModels(data.availableModels || []);
          setCurrentModelId(data.currentModelId || '');
          if (data.tier?.name) setTierName(data.tier.name);
          setInitializing(false);
          refreshSessionsList();
        }
      } catch (err: any) {
        if (mounted) {
          setError(err.message || 'Failed to initialize ACP session');
          setInitializing(false);
        }
      }
    }

    initSession();
    return () => {
      mounted = false;
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, [currentDirectory]);

  // Auto scroll to bottom when messages update
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Switch model
  const handleModelChange = async (newModelId: string) => {
    if (!sessionId || newModelId === currentModelId) return;
    try {
      setCurrentModelId(newModelId);
      await fetch(`/api/acp/sessions/${sessionId}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: newModelId }),
      });
    } catch (err) {
      console.error('Failed to switch ACP model:', err);
    }
  };

  // Select an existing session
  const selectSession = async (id: string) => {
    if (id === sessionId || loading) return;
    try {
      setInitializing(true);
      setError(null);
      const res = await fetch(`/api/acp/sessions/${id}`);
      if (res.ok) {
        const data = await res.json();
        setSessionId(data.sessionId);
        setCurrentModelId(data.currentModelId || '');
        if (data.availableModels) setModels(data.availableModels);
        setMessages(data.messages || []);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInitializing(false);
    }
  };

  // Delete a session
  const deleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await fetch(`/api/acp/sessions/${id}`, { method: 'DELETE' });
      if (id === sessionId) {
        handleNewSession();
      } else {
        refreshSessionsList();
      }
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  };

  // Reset / New Conversation
  const handleNewSession = async () => {
    if (loading && abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setMessages([]);
    setError(null);
    setInitializing(true);
    try {
      const res = await fetch('/api/acp/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'antigravity', cwd: currentDirectory }),
      });
      const data = await res.json();
      setSessionId(data.sessionId);
      setModels(data.availableModels || []);
      setCurrentModelId(data.currentModelId || '');
      refreshSessionsList();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setInitializing(false);
    }
  };

  // Stop Generation
  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setLoading(false);
    setMessages((prev) =>
      prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false, text: m.text ? `${m.text} *(generation stopped)*` : '*(generation stopped)*' } : m))
    );
  };

  // Send prompt
  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || !sessionId || loading) return;

    const userMsgId = `user-${Date.now()}`;
    const assistantMsgId = `assistant-${Date.now()}`;

    const userMsg: Message = { id: userMsgId, role: 'user', text: trimmed };
    const assistantMsg: Message = {
      id: assistantMsgId,
      role: 'assistant',
      text: '',
      thought: '',
      tools: [],
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setLoading(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch(`/api/acp/sessions/${sessionId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed, stream: true }),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Failed to send prompt (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const rawEvent of events) {
          const lines = rawEvent.split('\n');
          let eventType = 'message';
          let eventData = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6).trim();
            }
          }

          if (!eventData) continue;
          try {
            const parsed = JSON.parse(eventData);

            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantMsgId) return m;

                if (eventType === 'thought_delta') {
                  return { ...m, thought: (m.thought || '') + (parsed.thought || '') };
                } else if (eventType === 'text_delta') {
                  return { ...m, text: m.text + (parsed.text || '') };
                } else if (eventType === 'tool_call') {
                  const tools = [...(m.tools || []), parsed.tool];
                  return { ...m, tools };
                } else if (eventType === 'done') {
                  return { ...m, isStreaming: false };
                }
                return m;
              })
            );
          } catch {}
        }
      }
      refreshSessionsList();
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, text: m.text ? `${m.text}\n\n*[Error: ${err.message}]*` : `*[Error: ${err.message}]*`, isStreaming: false }
              : m
          )
        );
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsgId ? { ...m, isStreaming: false } : m))
      );
    }
  };

  return (
    <div className={cn('flex h-full w-full bg-background text-foreground overflow-hidden', !active && 'hidden')}>
      {/* Collapsible Session Selector Sidebar */}
      {sidebarOpen && (
        <div className="w-64 flex flex-col border-r border-border bg-card/30 shrink-0 transition-all select-none">
          <div className="flex items-center justify-between p-3 border-b border-border">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <span className="text-primary font-bold">✦</span> ACP Sessions
            </span>
            <button
              type="button"
              onClick={handleNewSession}
              disabled={initializing || loading}
              className="text-xs px-2.5 py-1 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 font-medium transition-opacity flex items-center gap-1 shadow-sm"
              title="Start a new session"
            >
              <span>+</span> New
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessionsList.length === 0 ? (
              <div className="text-center py-8 text-xs text-muted-foreground">
                No previous sessions
              </div>
            ) : (
              sessionsList.map((s) => (
                <div
                  key={s.sessionId}
                  onClick={() => selectSession(s.sessionId)}
                  className={cn(
                    'group relative flex items-center justify-between px-3 py-2.5 rounded-lg text-xs cursor-pointer border transition-colors',
                    s.sessionId === sessionId
                      ? 'bg-accent/80 border-border text-foreground font-medium shadow-sm'
                      : 'border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                  )}
                >
                  <div className="truncate flex-1 pr-2">
                    <div className="truncate text-xs">{s.title || 'Untitled Session'}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {s.currentModelId.split('-')[0] || 'gemini'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => deleteSession(e, s.sessionId)}
                    className="opacity-0 group-hover:opacity-100 hover:text-destructive p-1 rounded transition-opacity"
                    title="Delete session"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Main Chat Column */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-background">
        {/* Top Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/40 backdrop-blur-sm z-10 shrink-0">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors text-xs font-mono"
              title={sidebarOpen ? 'Hide ACP Sessions' : 'Show ACP Sessions'}
            >
              {sidebarOpen ? '◀' : '▶'}
            </button>

            <div className="flex items-center gap-2">
              <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-semibold text-sm tracking-tight text-foreground flex items-center gap-1.5">
                <span className="text-primary font-bold">✦</span> Google Antigravity
              </span>
            </div>

            <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium border border-primary/20">
              {tierName}
            </span>

            <span className="text-xs text-muted-foreground truncate max-w-[200px]" title={currentDirectory}>
              {currentDirectory.split('/').pop()}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {models.length > 0 && (
              <select
                value={currentModelId}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={loading || initializing}
                className="bg-card border border-border text-foreground text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary font-medium shadow-sm"
              >
                {models.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={handleNewSession}
              disabled={initializing || loading}
              className="px-3 py-1.5 rounded-lg border border-border hover:bg-accent text-foreground text-xs font-medium transition-colors"
            >
              New Chat
            </button>
          </div>
        </div>

        {/* Scrollable Message History Area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          {error && (
            <div className="p-4 rounded-xl border border-destructive/40 bg-destructive/10 text-destructive text-sm max-w-2xl mx-auto flex items-center justify-between">
              <span>{error}</span>
              <button onClick={handleNewSession} className="text-xs underline font-semibold ml-2">
                Retry
              </button>
            </div>
          )}

          {initializing && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-3 opacity-60">
              <div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-medium text-foreground">Initializing Google Antigravity ACP Session...</p>
            </div>
          )}

          {!initializing && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center max-w-lg mx-auto space-y-4">
              <div className="h-12 w-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary text-2xl font-bold shadow-sm">
                ✦
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-foreground">Direct Antigravity ACP Session</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Connected directly to Google Antigravity CLI via stdio ACP. Thinking traces stream uncollapsed in real time, with model switching and live tool execution.
                </p>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={cn('flex flex-col max-w-4xl mx-auto space-y-2', msg.role === 'user' ? 'items-end' : 'items-start')}>
              {msg.role === 'user' ? (
                <div className="px-4 py-2.5 rounded-2xl bg-primary text-primary-foreground text-sm font-normal max-w-[85%] whitespace-pre-wrap shadow-sm">
                  {msg.text}
                </div>
              ) : (
                <div className="w-full space-y-3">
                  {/* Live Uncollapsed Thinking Box */}
                  {msg.thought && (
                    <div className="p-3.5 rounded-xl border border-border/80 bg-muted/30 text-xs font-mono text-muted-foreground space-y-2">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground/80 uppercase tracking-wider">
                        <span className="h-2 w-2 rounded-full bg-primary/60" />
                        Thinking & Reasoning (Uncollapsed)
                      </div>
                      <div className="whitespace-pre-wrap leading-relaxed opacity-90 max-h-64 overflow-y-auto">
                        {msg.thought}
                      </div>
                    </div>
                  )}

                  {/* Tool calls */}
                  {msg.tools && msg.tools.length > 0 && (
                    <div className="space-y-1.5">
                      {msg.tools.map((t, idx) => (
                        <div key={idx} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card/60 text-xs font-mono text-foreground shadow-xs">
                          <span className="text-primary font-bold">λ</span>
                          <span className="font-semibold text-muted-foreground">{t.name || t.tool?.name || 'Tool Call'}:</span>
                          <span className="truncate opacity-80">{JSON.stringify(t.args || t.tool?.args || {})}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Main Assistant Content */}
                  <div className="px-5 py-4 rounded-2xl bg-card border border-border text-foreground text-sm leading-relaxed max-w-full shadow-sm prose prose-sm dark:prose-invert">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.text || (msg.isStreaming ? '...' : '')}
                    </ReactMarkdown>
                    {msg.isStreaming && (
                      <span className="inline-block w-2 h-4 ml-1 bg-primary animate-pulse align-middle" />
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Bottom Input Area with Stop button */}
        <div className="p-4 border-t border-border bg-card/20 shrink-0">
          <form onSubmit={handleSend} className="max-w-4xl mx-auto flex items-end gap-2 bg-background border border-border rounded-xl p-2.5 shadow-sm focus-within:ring-1 focus-within:ring-primary focus-within:border-primary">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={`Message Antigravity (${models.find((m) => m.modelId === currentModelId)?.name || 'ACP'})...`}
              rows={1}
              disabled={loading || initializing}
              className="flex-1 bg-transparent border-0 resize-none text-sm px-2 py-1.5 focus:outline-none text-foreground placeholder:text-muted-foreground min-h-[36px] max-h-32"
            />

            {loading ? (
              <button
                type="button"
                onClick={handleStop}
                className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground font-medium text-xs hover:bg-destructive/90 transition-colors flex items-center gap-1.5 shadow-sm cursor-pointer"
                title="Stop generation"
              >
                <span className="h-2 w-2 rounded-xs bg-white animate-pulse" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || initializing}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-xs hover:opacity-90 disabled:opacity-40 transition-opacity cursor-pointer shadow-sm"
              >
                Send
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
};
