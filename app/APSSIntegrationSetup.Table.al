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
        }
        field(3; "Default Customer No."; Code[20])
        {
            DataClassification = ToBeClassified;
            Caption = 'Default Customer No.';
            TableRelation = Customer;
        }
    }

    keys
    {
        key(PK; "Primary Key")
        {
            Clustered = true;
        }
    }
}
