!macro customUnInstall
  ; Get AppData\Roaming\ModelNest location
  ${if} ${FileExists} "$APPDATA\ModelNest"
    ; Delete cache directory
    ${if} ${FileExists} "$APPDATA\ModelNest\cache"
      RMDir /r "$APPDATA\ModelNest\cache"
      DetailPrint "Removed cache directory: $APPDATA\ModelNest\cache"
    ${endif}
    
    ; Delete logs directory
    ${if} ${FileExists} "$APPDATA\ModelNest\logs"
      RMDir /r "$APPDATA\ModelNest\logs"
      DetailPrint "Removed logs directory: $APPDATA\ModelNest\logs"
    ${endif}
    
    ; Note: We're not deleting the entire ModelNest directory to preserve user settings
  ${endif}
!macroend 