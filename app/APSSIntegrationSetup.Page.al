page 70301 "APSS Integration Setup"
{
    PageType = Card;
    ApplicationArea = All;
    UsageCategory = Administration;
    SourceTable = "APSS Integration Setup";
    Caption = 'APSS Integration Setup';

    layout
    {
        area(Content)
        {
            group(General)
            {
                Caption = 'General';
                field("Middleware Base URL"; Rec."Middleware Base URL")
                {
                    ApplicationArea = All;
                    ToolTip = 'Specifies the base URL of the APSS Integration Hub (e.g. http://localhost:3000)';
                }
                field("Default Customer No."; Rec."Default Customer No.")
                {
                    ApplicationArea = All;
                    ToolTip = 'Specifies the default customer to create Sales Quotes for';
                }
                field("API Key"; Rec."API Key")
                {
                    ApplicationArea = All;
                    ExtendedDatatype = Masked;
                    ToolTip = 'Specifies the API key / Access Code to connect to the APSS Integration Hub';
                }
            }
        }
    }

    trigger OnOpenPage()
    begin
        Rec.Reset();
        if not Rec.Get() then begin
            Rec.Init();
            Rec."Middleware Base URL" := 'http://localhost:3000';
            Rec.Insert();
        end;
    end;
}
