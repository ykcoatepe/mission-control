import { useEffect, useRef, useState } from 'react'
import { Bot, Loader2, MessageCircle, Send, User, X } from 'lucide-react'
import { useChat } from '../hooks/useChat'
import { markdownToHtml, sanitizeHtml } from '../utils/sanitize'
import { cx } from './ui/cx'
import styles from './ChatWidget.module.css'

type ChatWidgetProps = {
  hideLauncher?: boolean
}

export default function ChatWidget({ hideLauncher = false }: ChatWidgetProps) {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const openRef = useRef(open)
  const { abortStream, input, inputRef, isStreaming, messages, messagesEndRef, sendMessage, setInput } =
    useChat({
      onDelta: () => {
        if (!openRef.current) setUnread((prev) => prev + 1)
      },
    })

  useEffect(() => {
    openRef.current = open
    if (open) {
      inputRef.current?.focus()
    } else if (isStreaming) {
      abortStream()
    }
  }, [abortStream, inputRef, isStreaming, open])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string; autoSend?: boolean }>).detail
      setUnread(0)
      setOpen(true)
      if (!detail?.message) return
      if (detail.autoSend) {
        void sendMessage(detail.message)
        return
      }
      setInput(detail.message)
    }

    window.addEventListener('open-chat', handler)
    return () => window.removeEventListener('open-chat', handler)
  }, [sendMessage, setInput])

  return (
    <>
      {!open && !hideLauncher && (
        <button
          type="button"
          aria-label={unread > 0 ? `Open assistant, ${unread} unread` : 'Open assistant'}
          onClick={() => {
            setUnread(0)
            setOpen(true)
          }}
          className={styles.floatingButton}
        >
          <MessageCircle size={22} aria-hidden="true" />
          {unread > 0 && <span className={styles.unreadBadge}>{unread > 9 ? '9+' : unread}</span>}
        </button>
      )}

      {open && (
          <div
            role="dialog"
            aria-label="Assistant"
            className={styles.panel}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false)
            }}
          >
            <div className={styles.header}>
              <div className={styles.headerInfo}>
                <div className={styles.headerIcon}>
                  <Bot size={16} aria-hidden="true" />
                </div>
                <div>
                  <h3 className={styles.headerTitle}>Müdür</h3>
                  <p className={styles.headerStatus}>{isStreaming ? 'Replying' : 'Online'}</p>
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className={styles.headerButton} aria-label="Close assistant">
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className={styles.messages} role="log" aria-live="polite" aria-label="Conversation">
              {messages.length === 0 ? (
                <div className={styles.emptyState}>
                  <Bot size={32} aria-hidden="true" />
                  <p className={styles.emptyText}>Ask me anything.</p>
                </div>
              ) : (
                <div className={styles.messageList}>
                  {messages.map((msg) => (
                    <div key={msg.id} className={styles.messageRow}>
                      <div
                        className={`${styles.avatar} ${
                          msg.role === 'assistant' ? styles.avatarAssistant : styles.avatarUser
                        }`}
                      >
                        {msg.role === 'assistant' ? <Bot size={13} /> : <User size={13} />}
                      </div>
                      <div className={styles.messageBody}>
                        <div className={styles.messageMeta}>
                          <span className={styles.messageAuthor}>
                            {msg.role === 'assistant' ? 'Müdür' : 'You'}
                          </span>
                          {msg.streaming && <Loader2 size={10} className={styles.spin} aria-hidden="true" />}
                        </div>
                        <div
                          className={styles.messageContent}
                          dangerouslySetInnerHTML={{
                            __html: sanitizeHtml(
                              markdownToHtml(
                                msg.content || (msg.streaming ? 'Müdür is preparing a reply...' : ''),
                              ),
                            ),
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            <div className={styles.inputBar}>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void sendMessage()
                }}
                className={styles.composer}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void sendMessage()
                    }
                  }}
                  placeholder="Message…"
                  aria-label="Message"
                  disabled={isStreaming}
                  rows={3}
                  className={styles.textarea}
                  onInput={(event) => {
                    const target = event.currentTarget
                    target.style.height = 'auto'
                    target.style.height = `${Math.min(target.scrollHeight, 150)}px`
                  }}
                />
                <button
                  type="submit"
                  data-chat-send
                  disabled={!input.trim() || isStreaming}
                  aria-label="Send message"
                  className={cx(styles.sendButton, input.trim() && !isStreaming && styles.sendButtonActive)}
                >
                  {isStreaming ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                </button>
              </form>
            </div>
          </div>
      )}
    </>
  )
}
