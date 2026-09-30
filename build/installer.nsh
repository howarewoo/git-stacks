; electron-builder includes this at its default nsis.include path.
; The installing instance may differ from the process the app spawned after
; elevation. Cleanup requires its echoed token AND proof that its PID is gone.
!macro customHeader
  Var /GLOBAL GITSTACKS_handoffHandle
  Var /GLOBAL GITSTACKS_handoffToken
  Var /GLOBAL GITSTACKS_handoffPid
!macroend

; Runs after files/registry/shortcuts are installed, before launching the app.
; The request is the raw ASCII token terminated by EOF, with no prefix/newline.
; FileRead's default string bound applies; the app requires an exact token match.
!macro customInstall
  IfFileExists "$EXEDIR\git-stacks-handoff.txt" 0 gitstacks_handoff_done
  ClearErrors
  FileOpen $GITSTACKS_handoffHandle "$EXEDIR\git-stacks-handoff.txt" r
  IfErrors gitstacks_handoff_done
  FileRead $GITSTACKS_handoffHandle $GITSTACKS_handoffToken
  FileClose $GITSTACKS_handoffHandle
  IfErrors gitstacks_handoff_done

  ; Use our own variable without clobbering the surrounding installer's registers.
  System::Call 'kernel32::GetCurrentProcessId() i.s'
  Pop $GITSTACKS_handoffPid

  FileOpen $GITSTACKS_handoffHandle "$EXEDIR\git-stacks-install-complete.txt" w
  IfErrors gitstacks_handoff_done
  FileWrite $GITSTACKS_handoffHandle "token=$GITSTACKS_handoffToken$\r$\n"
  FileWrite $GITSTACKS_handoffHandle "pid=$GITSTACKS_handoffPid$\r$\n"
  FileClose $GITSTACKS_handoffHandle
  IfErrors gitstacks_handoff_done
  Delete "$EXEDIR\git-stacks-handoff.txt"
  gitstacks_handoff_done:
!macroend
