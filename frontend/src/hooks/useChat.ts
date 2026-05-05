import { useCallback, useEffect, useRef, useState } from 'react'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  streaming?: boolean
}

interface UseChatOptions {
  endpoint?: string
  onDelta?: (delta: string, accumulated: string) => void
}

const uuid = () => 'xxxx-xxxx-xxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16))

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

export function useChat(options: UseChatOptions = {}) {
  const { endpoint = '/api/chat', onDelta } = options
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef<ChatMessage[]>([])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  const abortStream = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
    setMessages((prev) =>
      prev.map((message) =>
        message.streaming ? { ...message, streaming: false } : message,
      ),
    )
  }, [])

  useEffect(() => abortStream, [abortStream])

  const clearChat = useCallback(() => {
    abortStream()
    setMessages([])
  }, [abortStream])

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()
    if (!text || isStreaming) return

    const userMsg: ChatMessage = { id: uuid(), role: 'user', content: text, timestamp: new Date() }
    const assistantId = uuid()
    const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', timestamp: new Date(), streaming: true }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput('')
    setIsStreaming(true)

    const history = [...messagesRef.current, userMsg].map((message) => ({
      role: message.role,
      content: message.content,
    }))

    try {
      abortRef.current = new AbortController()
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, stream: true }),
        signal: abortRef.current.signal,
      })

      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
      let buffer = ''

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = done ? '' : lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6)
            if (data === '[DONE]') continue
            try {
              const delta = JSON.parse(data).choices?.[0]?.delta?.content
              if (!delta) continue
              accumulated += delta
              onDelta?.(delta, accumulated)
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === assistantId ? { ...message, content: accumulated } : message,
                ),
              )
            } catch {
              // Ignore malformed delta chunks from the stream.
            }
          }
          if (done) break
        }
      }

      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId ? { ...message, streaming: false } : message,
        ),
      )
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, content: `⚠️ ${errorMessage(error)}`, streaming: false }
              : message,
          ),
        )
      }
    } finally {
      setIsStreaming(false)
      abortRef.current = null
    }
  }, [endpoint, input, isStreaming, onDelta])

  return {
    abortRef,
    abortStream,
    clearChat,
    input,
    inputRef,
    isStreaming,
    messages,
    messagesEndRef,
    sendMessage,
    setInput,
  }
}
