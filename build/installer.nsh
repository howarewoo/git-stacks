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
  Var /GLOBAL GITSTACKS_handoffHandle
  Var /GLOBAL GITSTACKS_handoffToken
  Var /GLOBAL GITSTACKS_handoffPid
!macroend

; Inserted by electron-builder at the end of the install section: after the
; application files, the registry and the shortcuts are in place, and before
; this installer starts the app and quits. Whatever this process still needs its
; own executable for is done by this point.
; NSIS notes. The variables are declared with `Var /GLOBAL name` and read as
; `$name`; `${name}` is a preprocessor define and would resolve to nothing here.
; `FileRead` with an empty terminator reads one whole line and leaves the line
; ending out of the value, so what comes back is the token and only the token.
; A line ending in the answer is written `$\r$\n`, which is the two bytes a
; Windows text file carries — a bare `$` would write a dollar sign.
!macro customInstall
  IfFileExists "$EXEDIR\git-stacks-handoff.txt" 0 gitstacks_handoff_done
    FileOpen $GITSTACKS_handoffHandle "$EXEDIR\git-stacks-handoff.txt" r
    FileRead $GITSTACKS_handoffHandle $GITSTACKS_handoffToken ""
    FileClose $GITSTACKS_handoffHandle
    ; The token has been read once. Leaving it behind would leave a later run a
    ; name to answer for, so it goes with this read.
    Delete "$EXEDIR\git-stacks-handoff.txt"

    ; No guess is made here about what a token looks like. The token is echoed
    ; exactly as it was found and the app compares the whole value against the
    ; one it wrote, so a line of any other content, of any length, is not an
    ; answer it can use and the copy stays. The read is one line, so it cannot
    ; run away either.
    ; The id of the process doing the work now, which is this one when nothing
    ; elevated and the elevated instance when something did. The call returns
    ; onto the stack and is popped into our own variable, so the register the
    ; caller may still be using is left exactly as it was found.
    System::Call 'kernel32::GetCurrentProcessId() i.s'
    Pop $GITSTACKS_handoffPid

    ; One field per line, each written the way this app writes the request — a
    ; CRLF line, ASCII token, nothing else — so what is read back is the value
    ; and nothing else.
    FileOpen $GITSTACKS_handoffHandle "$EXEDIR\git-stacks-install-complete.txt" w
    FileWrite $GITSTACKS_handoffHandle "token=$GITSTACKS_handoffToken$\r$\n"
    FileWrite $GITSTACKS_handoffHandle "pid=$GITSTACKS_handoffPid$\r$\n"
    FileClose $GITSTACKS_handoffHandle
  gitstacks_handoff_done:
!macroend
