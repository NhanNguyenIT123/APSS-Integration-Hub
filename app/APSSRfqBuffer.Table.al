table 70300 "APSS RFQ Buffer"
{
    DataClassification = ToBeClassified;
    Caption = 'APSS RFQ Buffer';

    fields
    {
        field(1; "RFQ No."; Code[50])
        {
            DataClassification = ToBeClassified;
            Caption = 'RFQ No.';
        }
        field(2; Subject; Text[250])
        {
            DataClassification = ToBeClassified;
            Caption = 'Subject';
        }
        field(3; Drafter; Text[100])
        {
            DataClassification = ToBeClassified;
            Caption = 'Drafter';
        }
        field(4; "Register Date"; Text[50])
        {
            DataClassification = ToBeClassified;
            Caption = 'Register Date';
        }
        field(5; "Close Date"; Text[50])
        {
            DataClassification = ToBeClassified;
            Caption = 'Close Date';
        }
        field(6; Portal; Text[50])
        {
            DataClassification = ToBeClassified;
            Caption = 'Portal';
        }
        field(7; "Item Count"; Integer)
        {
            DataClassification = ToBeClassified;
            Caption = 'Item Count';
        }
        field(8; "Sales Quote Created"; Code[20])
        {
            DataClassification = ToBeClassified;
            Caption = 'Sales Quote Created';
            TableRelation = "Sales Header"."No." where("Document Type" = const(Quote));
        }
    }

    keys
    {
        key(PK; "RFQ No.")
        {
            Clustered = true;
        }
    }
}
