table 70301 "APSS Integration Setup"
{
    DataClassification = ToBeClassified;
    Caption = 'APSS Integration Setup';

    fields
    {
        field(1; "Primary Key"; Code[10])
        {
            DataClassification = ToBeClassified;
            Caption = 'Primary Key';
        }
        field(2; "Middleware Base URL"; Text[250])
        {
            DataClassification = ToBeClassified;
            Caption = 'Middleware Base URL';

            trigger OnValidate()
            begin
                ValidateMiddlewareBaseUrl();
            end;
        }
        field(3; "Default Customer No."; Code[20])
        {
            DataClassification = ToBeClassified;
            Caption = 'Default Customer No.';
            TableRelation = Customer;
        }
        field(4; "API Key"; Text[100])
        {
            DataClassification = ToBeClassified;
            Caption = 'API Key';
        }
    }

    keys
    {
        key(PK; "Primary Key")
        {
            Clustered = true;
        }
    }

    procedure GetSetupRecord()
    begin
        if not Get() then begin
            Init();
            "Middleware Base URL" := 'http://localhost:3000';
            Insert();
        end;
        ValidateMiddlewareBaseUrl();
    end;

    local procedure ValidateMiddlewareBaseUrl()
    var
        LowerCaseUrl: Text;
    begin
        if "Middleware Base URL" = '' then
            exit;

        LowerCaseUrl := LowerCase("Middleware Base URL");
        if StrPos(LowerCaseUrl, 'https://') = 1 then
            exit;

        if (StrPos(LowerCaseUrl, 'http://localhost') = 1) or
           (StrPos(LowerCaseUrl, 'http://127.0.0.1') = 1) or
           (StrPos(LowerCaseUrl, 'http://[::1]') = 1) then
            exit;

        Error('Middleware Base URL must use HTTPS unless it points to localhost or loopback.');
    end;
}
