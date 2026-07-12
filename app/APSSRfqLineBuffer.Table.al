table 70304 "APSS RFQ Line Buffer"
{
    DataClassification = ToBeClassified;
    Caption = 'APSS RFQ Line Buffer';

    fields
    {
        field(1; "RFQ No."; Code[50])
        {
            DataClassification = ToBeClassified;
            Caption = 'RFQ No.';
        }
        field(2; "Line No."; Integer)
        {
            DataClassification = ToBeClassified;
            Caption = 'Line No.';
        }
        field(3; "Material Code"; Code[50])
        {
            DataClassification = ToBeClassified;
            Caption = 'Material Code';
        }
        field(4; "Material Description"; Text[100])
        {
            DataClassification = ToBeClassified;
            Caption = 'Material Description';
        }
        field(5; "Long Description"; Text[250])
        {
            DataClassification = ToBeClassified;
            Caption = 'Long Description';
        }
        field(6; "Part Number"; Text[50])
        {
            DataClassification = ToBeClassified;
            Caption = 'Part Number';
        }
        field(7; Manufacturer; Text[100])
        {
            DataClassification = ToBeClassified;
            Caption = 'Manufacturer';
        }
        field(8; UOM; Code[10])
        {
            DataClassification = ToBeClassified;
            Caption = 'UOM';
        }
        field(9; Quantity; Decimal)
        {
            DataClassification = ToBeClassified;
            Caption = 'Quantity';
        }
        field(10; "Matched Item No."; Code[20])
        {
            DataClassification = ToBeClassified;
            Caption = 'Matched Item No.';
            TableRelation = Item;
        }
        field(11; "Match Status"; Option)
        {
            DataClassification = ToBeClassified;
            Caption = 'Match Status';
            OptionMembers = "Create Blank",Review,"Auto-Link";
            OptionCaption = 'Create Blank,Review,Auto-Link';
        }
        field(12; "Match Score"; Decimal)
        {
            DataClassification = ToBeClassified;
            Caption = 'Match Score %';
        }
        field(13; "Match Reason"; Text[250])
        {
            DataClassification = ToBeClassified;
            Caption = 'Match Reason';
        }
        field(14; "BC Item Description"; Text[100])
        {
            FieldClass = FlowField;
            CalcFormula = lookup(Item.Description where("No." = field("Matched Item No.")));
            Caption = 'BC Item Description';
            Editable = false;
        }
    }

    keys
    {
        key(PK; "RFQ No.", "Line No.")
        {
            Clustered = true;
        }
    }
}
