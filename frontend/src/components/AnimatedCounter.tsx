import { useEffect, useRef, useState } from 'react'

interface Props {
  end: number
  duration?: number
  decimals?: number
  prefix?: string
  suffix?: string
  className?: string
  formatter?: (value: number) => string
}

export default function AnimatedCounter({ end, duration = 1.5, decimals = 0, prefix = '', suffix = '', className = '', formatter }: Props) {
  const [count, setCount] = useState(0)
  const ref = useRef<number>(0)
  const startTime = useRef<number>(0)

  useEffect(() => {
    startTime.current = Date.now()
    const animate = () => {
      const elapsed = Date.now() - startTime.current
      const progress = Math.min(elapsed / (duration * 1000), 1)
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = eased * end
      setCount(current)
      if (progress < 1) {
        ref.current = requestAnimationFrame(animate)
      }
    }
    ref.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(ref.current)
  }, [end, duration])

  return (
    <span className={className}>
      {formatter ? formatter(count) : `${prefix}${count.toFixed(decimals)}${suffix}`}
    </span>
  )
}
