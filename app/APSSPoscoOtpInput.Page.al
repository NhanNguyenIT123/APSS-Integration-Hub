page 70307 "APSS POSCO OTP Input"
{
    PageType = StandardDialog;
    Caption = 'POSCO OTP Verification';

    layout
    {
        area(Content)
        {
            group(General)
            {
                Caption = 'Enter OTP';
                field(OtpCodeField; OtpCode)
                {
                    ApplicationArea = All;
                    Caption = 'OTP Code';
                    ToolTip = 'Enter the OTP code sent to your procurement email';
                }
            }
        }
    }

    var
        OtpCode: Text[20];

    procedure GetOtpCode(): Text
    begin
        exit(OtpCode);
    end;
}
