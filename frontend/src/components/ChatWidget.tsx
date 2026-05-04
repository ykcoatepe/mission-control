import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Bot, Loader2, MessageCircle, Minimize2, Send, User, X } from 'lucide-react'
import { useChat } from '../hooks/useChat'
import { markdownToHtml, sanitizeHtml } from '../utils/sanitize'
import { useIsMobile } from '../lib/useIsMobile'
import styles from './ChatWidget.module.css'

type ChatWidgetProps = {
  hideLauncher?: boolean
}

export default function ChatWidget({ hideLauncher = false }: ChatWidgetProps) {
  const m = useIsMobile()
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
      <AnimatePresence>
        {!open && !hideLauncher && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            onClick={() => {
              setUnread(0)
              setOpen(true)
            }}
            className={`${styles.floatingButton} ${
              m ? styles.floatingButtonMobile : styles.floatingButtonDesktop
            }`}
          >
            <MessageCircle size={m ? 22 : 24} />
            {unread > 0 && (
              <div className={styles.unreadBadge}>{unread > 9 ? '9+' : unread}</div>
            )}
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={m ? { y: '100%' } : { opacity: 0, y: 20, scale: 0.95 }}
            animate={m ? { y: 0 } : { opacity: 1, y: 0, scale: 1 }}
            exit={m ? { y: '100%' } : { opacity: 0, y: 20, scale: 0.95 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className={`${styles.panel} ${m ? styles.panelMobile : styles.panelDesktop}`}
          >
            <div className={`${styles.header} ${m ? styles.headerMobile : ''}`}>
              <div className={styles.headerInfo}>
                <div className={styles.headerIcon}>
                  <Bot size={16} style={{ color: '#007AFF' }} />
                </div>
                <div>
                  <h3 className={styles.headerTitle}>Müdür</h3>
                  <p className={styles.headerStatus}>Online</p>
                </div>
              </div>
              <button onClick={() => setOpen(false)} className={styles.headerButton}>
                {m ? <X size={16} /> : <Minimize2 size={14} />}
              </button>
            </div>

            <div className={styles.messages}>
              {messages.length === 0 ? (
                <div className={styles.emptyState}>
                  <Bot size={32} />
                  <p style={{ fontSize: 13, fontWeight: 500, textAlign: 'center' }}>Ask me anything!</p>
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
                          {msg.streaming && (
                            <Loader2 size={9} style={{ color: '#007AFF', animation: 'spin 1s linear infinite' }} />
                          )}
                        </div>
                        <div
                          className={styles.messageContent}
                          dangerouslySetInnerHTML={{
                            __html: sanitizeHtml(markdownToHtml(msg.content || '...')),
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
                  placeholder="Message..."
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
                  className={`${styles.sendButton} ${
                    input.trim() && !isStreaming ? styles.sendButtonActive : ''
                  }`}
                >
                  {isStreaming ? (
                    <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  ) : (
                    <Send size={14} />
                  )}
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
