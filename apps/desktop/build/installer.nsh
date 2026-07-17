; ─────────────────────────────────────────────────────────────────────
; Custom NSIS include. electron-builder auto-includes
; ${buildResources}/installer.nsh — i.e. this file — when building the
; NSIS target, and recognizes the customInstall / customUnInstall macros.
;
; Purpose: add "New > CardMirror Document" to Windows Explorer's
; right-click menu via the classic ShellNew mechanism. A registry value
; under the .cmir extension points Explorer at a template file the
; installer ships (electron-builder `extraResources` puts it at
; $INSTDIR\resources\new-template.cmir; generate it with
; `npm run gen:new-template`). Choosing the menu item copies that
; template — a valid empty .cmir — into the current folder. It opens
; through the .cmir association that electron-builder's
; `fileAssociations` already registers, and the submenu label is that
; association's friendly name ("CardMirror Document").
;
; SHCTX resolves to HKLM for a per-machine install and HKCU for a
; per-user install, so the ShellNew key lands in the same hive where the
; .cmir association itself was written.
;
; ⚠ UNTESTED ON WINDOWS. Verify on a real machine before relying on it.
; Explorer caches ShellNew, so the entry may not appear until the next
; sign-in or an Explorer restart. If you switch the installer between
; per-user and per-machine, SHCTX follows automatically.
; ─────────────────────────────────────────────────────────────────────

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\.cmir\ShellNew" "FileName" "$INSTDIR\resources\new-template.cmir"
!macroend

!macro customUnInstall
  ; Remove only the ShellNew subkey — electron-builder manages the rest
  ; of the .cmir association and its own teardown.
  DeleteRegKey SHCTX "Software\Classes\.cmir\ShellNew"
!macroend
