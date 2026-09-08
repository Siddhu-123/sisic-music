import { useEffect, useRef } from 'react';

const activeDialogs = [];

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialogFocus(active, onClose, { canClose = true } = {}) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);

  useEffect(() => {
    onCloseRef.current = onClose;
    canCloseRef.current = canClose;
  }, [canClose, onClose]);

  useEffect(() => {
    if (!active) return undefined;
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    activeDialogs.push(dialog);
    const focusable = () => [...(dialog?.querySelectorAll(FOCUSABLE_SELECTOR) || [])].filter(item => item.getClientRects().length > 0);
    (dialog?.querySelector('[data-dialog-autofocus]') || focusable()[0] || dialog)?.focus?.();

    const handleKeyDown = event => {
      if (event.defaultPrevented || activeDialogs.at(-1) !== dialog) return;
      if (event.key === 'Escape' && canCloseRef.current) {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const wasTop = activeDialogs.at(-1) === dialog;
      const index = activeDialogs.lastIndexOf(dialog);
      if (index >= 0) activeDialogs.splice(index, 1);
      if (wasTop && previousFocus?.isConnected) previousFocus.focus?.();
    };
  }, [active]);

  return dialogRef;
}
