; Git Stacks NSIS customisation.
;
; electron-builder compiles this file into the Windows installer at its default
; `nsis.include` path, so the installer this repository publishes carries the
; protocol below without any packaging option being set.
;
; Why it exists. The app hands this installer a prepared copy of itself, in an
; owner-private directory, and closes so the installer can replace the files the
; app is running from. The app cannot watch this process to its end: elevation
; hands the work to a second instance of the same installer which starts after
; this one has gone, and no answer about the first process is an answer about the
; second. So the app cannot decide when the prepared copy is free by asking about
; any process it knows of — it can only be told.
;
; This is that telling. Before spawning the installer the app leaves a token
; beside the prepared copy, in the directory it created for this attempt alone.
; At the end of the install, in whichever process actually did the work — this
; one, or the elevated instance — the token is read back and written out again
; beside it with the process id of the instance that finished. The app removes
; the prepared copy only once it has read that back and found that process gone.
;
; Nothing here decides what the app should believe: the token is echoed exactly
; as it was found, and this installer writes nothing else and nowhere else. If
; the token is absent, unreadable, or this file is not compiled in at all, no
; completion is recorded, and the app keeps the copy.

!macro customHeader
  Var /GITSTACKS_handoffHandle
  Var /GITSTACKS_handoffToken
  Var /GITSTACKS_handoffPid
!macroend

; Inserted by electron-builder at the end of the install section: after the
; application files, the registry and the shortcuts are in place, and before
; this installer starts the app and quits. Whatever this process still needs its
; own executable for is done by this point.
!macro customInstall
  IfFileExists "$EXEDIR\git-stacks-handoff.txt" 0 gitstacks_handoff_done
    FileOpen ${GITSTACKS_handoffHandle} "$EXEDIR\git-stacks-handoff.txt" r
    FileRead ${GITSTACKS_handoffHandle} ${GITSTACKS_handoffToken} ""
    FileClose ${GITSTACKS_handoffHandle}
    ; The token has been read once. Leaving it behind would leave a later run a
    ; name to answer for, so it goes with this read.
    Delete "$EXEDIR\git-stacks-handoff.txt"

    ; The id of the process doing the work now, which is this one when nothing
    ; elevated and the elevated instance when something did.
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy ${GITSTACKS_handoffPid} "$0"

    ; One field per line, each written the way this app writes the request, so
    ; what is read back is the value and nothing else.
    FileOpen ${GITSTACKS_handoffHandle} "$EXEDIR\git-stacks-install-complete.txt" w
    FileWrite ${GITSTACKS_handoffHandle} "token=${GITSTACKS_handoffToken}$"
    FileWrite ${GITSTACKS_handoffHandle} "pid=${GITSTACKS_handoffPid}$"
    FileClose ${GITSTACKS_handoffHandle}
  gitstacks_handoff_done:
!macroend
