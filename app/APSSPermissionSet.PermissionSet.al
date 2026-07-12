permissionset 70300 "APSS PermissionSet"
{
    Assignable = true;
    Caption = 'APSS Integration Permissions';
    Permissions =
        tabledata "APSS Integration Setup" = RIMD,
        tabledata "APSS RFQ Buffer" = RIMD,
        tabledata "APSS RFQ Line Buffer" = RIMD;
}
