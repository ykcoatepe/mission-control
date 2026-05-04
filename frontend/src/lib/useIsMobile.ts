import { useState, useEffect } from 'react'

export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= breakpoint)
  
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = () => setIsMobile(window.innerWidth <= breakpoint)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [breakpoint])
  
  return isMobile
}

export function useIsSmall(breakpoint = 480) {
  const [isSmall, setIsSmall] = useState(() => typeof window !== 'undefined' && window.innerWidth <= breakpoint)
  
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = () => setIsSmall(window.innerWidth <= breakpoint)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [breakpoint])
  
  return isSmall
}
