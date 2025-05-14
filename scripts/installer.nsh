; This is the custom uninstall macro that will be called by the NSIS uninstaller
!macro customUnInstall
  ; Create a flag file that tells the app to clean up when it quits
  FileOpen $0 "$APPDATA\model-nest\.uninstall_cleanup_required" w
  FileWrite $0 "This file indicates that an uninstallation is in progress. The app should clean up cache and logs on exit."
  FileClose $0
  DetailPrint "Created uninstall flag file at $APPDATA\model-nest\.uninstall_cleanup_required"

  ; Get AppData\Roaming\model-nest location
  ${if} ${FileExists} "$APPDATA\model-nest"
    ; Delete cache directory
    ${if} ${FileExists} "$APPDATA\model-nest\cache"
      RMDir /r "$APPDATA\model-nest\cache"
      DetailPrint "Removed cache directory: $APPDATA\model-nest\cache"
    ${endif}
    
    ; Delete logs directory
    ${if} ${FileExists} "$APPDATA\model-nest\logs"
      RMDir /r "$APPDATA\model-nest\logs"
      DetailPrint "Removed logs directory: $APPDATA\model-nest\logs"
    ${endif}
    
    ; Note: We're not deleting the entire model-nest directory to preserve user settings
  ${endif}
!macroend

; This is the custom install macro that will be called by the NSIS installer
!macro customInstall
  # Custom install steps can go here
!macroend 