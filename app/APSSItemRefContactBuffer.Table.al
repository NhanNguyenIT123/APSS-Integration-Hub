table 70305 "APSS Item Ref Contact Buffer"
{
    TableType = Temporary;
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Entry No."; Integer)
        {
            DataClassification = SystemMetadata;
        }
        field(2; "Document No."; Code[20])
        {
            DataClassification = CustomerContent;
        }
        field(3; "Customer No."; Code[20])
        {
            DataClassification = CustomerContent;
        }
        field(4; "Customer Name"; Text[100])
        {
            DataClassification = CustomerContent;
        }
        field(5; "Contact No."; Code[20])
        {
            DataClassification = CustomerContent;
        }
        field(6; "Contact Name"; Text[100])
        {
            DataClassification = CustomerContent;
        }
        field(7; "Item No."; Code[20])
        {
            DataClassification = CustomerContent;
        }
        field(8; "Item Description"; Text[100])
        {
            DataClassification = CustomerContent;
        }
        field(9; "Unit of Measure Code"; Code[10])
        {
            DataClassification = CustomerContent;
        }
        field(10; "Reference No."; Text[100])
        {
            DataClassification = CustomerContent;
        }
        field(11; "Long Description"; Text[2048])
        {
            DataClassification = CustomerContent;
        }
        field(12; "Shipment Method"; Code[10])
        {
            DataClassification = CustomerContent;
        }
        field(13; "Incoterm Location"; Text[100])
        {
            DataClassification = CustomerContent;
        }
    }

    keys
    {
        key(PK; "Entry No.")
        {
            Clustered = true;
        }
    }
}
