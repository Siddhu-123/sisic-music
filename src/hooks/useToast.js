import { useState, useCallback, useEffect, useRef } from 'react';
let toastId = 0;
export function useToast() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Set());
  const addToast = useCallback((message, duration = 3000) => {
    const id = ++toastId;
    setToasts(prev => [...prev.slice(-4), { id, message }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
    timers.current.add(timer);
  }, []);
  useEffect(() => { const pending = timers.current; return () => { pending.forEach(clearTimeout); pending.clear(); }; }, []);
  return { toasts, addToast };
}
