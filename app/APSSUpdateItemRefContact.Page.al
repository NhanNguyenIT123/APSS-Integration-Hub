page 70305 "APSS Update Item Ref Contact"
{
    PageType = StandardDialog;
    SourceTable = "APSS Item Ref Contact Buffer";
    SourceTableTemporary = true;
    Caption = 'APSS Update Item Ref. Contact';
    ApplicationArea = All;

    layout
    {
        area(content)
        {
            group(Sales)
            {
                Caption = 'Sales';

                field("Document No."; Rec."Document No.")
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field("Customer No."; Rec."Customer No.")
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field("Customer Name"; Rec."Customer Name")
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field("Contact No."; Rec."Contact No.")
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field("Contact Name"; Rec."Contact Name")
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field("Item No."; Rec."Item No.")
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field("Item Description"; Rec."Item Description")
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field("Unit of Measure Code"; Rec."Unit of Measure Code")
                {
                    ApplicationArea = All;
                }
            }
            group("General Description")
            {
                Caption = 'General Description';

                field("Reference No."; Rec."Reference No.")
                {
                    ApplicationArea = All;
                    ShowMandatory = true;
                }
                field("Long Description"; Rec."Long Description")
                {
                    ApplicationArea = All;
                    ShowMandatory = true;
                    MultiLine = true;
                }
                field("Shipment Method"; Rec."Shipment Method")
                {
                    ApplicationArea = All;
                }
                field("Incoterm Location"; Rec."Incoterm Location")
                {
                    ApplicationArea = All;
                }
            }
        }
    }

    procedure SetDefaults(DocumentNo: Code[20]; CustomerNo: Code[20]; CustomerName: Text[100]; ContactNo: Code[20]; ContactName: Text[100]; ItemNo: Code[20]; ItemDescription: Text[100]; UomCode: Code[10]; ReferenceNo: Text; LongDescription: Text; ShipmentMethod: Code[10]; IncotermLocation: Text)
    begin
        Rec.Reset();
        Rec.DeleteAll();
        Rec.Init();
        Rec."Entry No." := 1;
        Rec."Document No." := DocumentNo;
        Rec."Customer No." := CustomerNo;
        Rec."Customer Name" := CustomerName;
        Rec."Contact No." := ContactNo;
        Rec."Contact Name" := ContactName;
        Rec."Item No." := ItemNo;
        Rec."Item Description" := ItemDescription;
        Rec."Unit of Measure Code" := UomCode;
        Rec."Reference No." := CopyStr(ReferenceNo, 1, MaxStrLen(Rec."Reference No."));
        Rec."Long Description" := CopyStr(LongDescription, 1, MaxStrLen(Rec."Long Description"));
        Rec."Shipment Method" := ShipmentMethod;
        Rec."Incoterm Location" := CopyStr(IncotermLocation, 1, MaxStrLen(Rec."Incoterm Location"));
        Rec.Insert();
    end;

    procedure GetValues(var ReferenceNo: Text; var LongDescription: Text; var UomCode: Code[10]; var ShipmentMethod: Code[10]; var IncotermLocation: Text)
    begin
        ReferenceNo := Rec."Reference No.";
        LongDescription := Rec."Long Description";
        UomCode := Rec."Unit of Measure Code";
        ShipmentMethod := Rec."Shipment Method";
        IncotermLocation := Rec."Incoterm Location";
    end;
}
