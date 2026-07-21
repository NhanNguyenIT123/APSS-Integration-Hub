table 70306 "APSS PTTEP Brand Group"
{
    DataClassification = ToBeClassified;
    Caption = 'APSS PTTEP Brand Group';

    fields
    {
        field(1; "Group Key"; Code[50])
        {
            DataClassification = ToBeClassified;
            Caption = 'Brand Group ID';
        }
        field(2; "Brand Name"; Text[100])
        {
            DataClassification = ToBeClassified;
            Caption = 'Brand';
        }
        field(3; "Item Count"; Integer)
        {
            DataClassification = ToBeClassified;
            Caption = 'Lines';
        }
        field(4; "Total Quantity"; Decimal)
        {
            DataClassification = ToBeClassified;
            Caption = 'Total Qty';
        }
        field(5; "Sample Description"; Text[250])
        {
            DataClassification = ToBeClassified;
            Caption = 'Description Sample';
        }
        field(6; "Close Date"; Text[30])
        {
            DataClassification = ToBeClassified;
            Caption = 'Close Date';
        }
    }

    keys
    {
        key(PK; "Group Key")
        {
            Clustered = true;
        }
    }
}
