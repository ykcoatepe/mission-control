import type { ReactNode } from 'react'
import { parseInline, parsePageText, shortenHome } from './pageMarkup'
import styles from './PageBody.module.css'

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, index): ReactNode => {
        if (part.kind === 'code') return <code key={index} className={styles.inlineCode}>{part.text}</code>
        if (part.kind === 'strong') return <strong key={index}>{part.text}</strong>
        if (part.kind === 'em') return <em key={index}>{part.text}</em>
        return part.text
      })}
    </>
  )
}

/**
 * A page as readable text: headings, lists and code blocks. Every piece is a React text node,
 * so page content can never inject markup. Source code is shown verbatim.
 */
export function PageBody({ content, asCode }: { content: string; asCode: boolean }) {
  const text = shortenHome(content)
  if (asCode) return <pre className={styles.code}>{text}</pre>
  return (
    <div className={styles.page}>
      {parsePageText(text).map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return block.level === 1 ? (
              <h3 key={index} className={styles.h1}><Inline text={block.text} /></h3>
            ) : block.level === 2 ? (
              <h4 key={index} className={styles.h2}><Inline text={block.text} /></h4>
            ) : (
              <h5 key={index} className={styles.h3}><Inline text={block.text} /></h5>
            )
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul'
            return (
              <Tag key={index} className={styles.list}>
                {block.items.map((item, at) => (
                  <li key={at}><Inline text={item} /></li>
                ))}
              </Tag>
            )
          }
          case 'code':
            return <pre key={index} className={styles.code}>{block.text}</pre>
          case 'rule':
            return <hr key={index} className={styles.rule} />
          default:
            return <p key={index} className={styles.paragraph}><Inline text={block.text} /></p>
        }
      })}
    </div>
  )
}
